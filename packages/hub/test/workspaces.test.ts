import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeRemoteUrl, isBlockedAddress } from "../src/git/url-safety.ts";
import { commitAll, gitOk, setupWorld, tmp, type World, writeFiles } from "./git-helpers.ts";

describe("remote URL safety", () => {
	const reject = async (url: string, opts = {}) => {
		await expect(assertSafeRemoteUrl(url, { resolve: async () => ["93.184.216.34"], ...opts })).rejects.toMatchObject({ code: "unsafeUrl" });
	};

	it("rejects file, plain http, git, ftp, option-like and credentialed URLs", async () => {
		for (const url of ["file:///etc/passwd", "/srv/repo.git", "C:\\repo", "http://example.com/r.git", "git://example.com/r.git", "ftp://example.com/r", "--upload-pack=evil", "https://user:pw@example.com/r.git", ""]) {
			await reject(url);
		}
	});

	it("rejects loopback, private, link-local and metadata addresses, literal or resolved", async () => {
		for (const url of [
			"https://localhost/r.git",
			"https://app.localhost/r.git",
			"https://127.0.0.1/r.git",
			"https://10.1.2.3/r.git",
			"https://192.168.0.5/r.git",
			"https://172.16.0.1/r.git",
			"https://169.254.169.254/latest",
			"https://[::1]/r.git",
			"https://[fd00::1]/r.git",
			"https://[::ffff:127.0.0.1]/r.git",
			"ssh://git@10.0.0.1/r.git",
			"git@192.168.1.1:team/r.git",
		]) {
			await reject(url);
		}
		await reject("https://internal.example.com/r.git", { resolve: async () => ["93.184.216.34", "10.0.0.7"] });
		await reject("https://gone.example.com/r.git", {
			resolve: async () => {
				throw new Error("ENOTFOUND");
			},
		});
	});

	it("accepts public https, ssh and scp-like git@ remotes", async () => {
		const resolve = async () => ["93.184.216.34"];
		await expect(assertSafeRemoteUrl("https://github.com/org/r.git", { resolve })).resolves.toBeUndefined();
		await expect(assertSafeRemoteUrl("ssh://git@github.com/org/r.git", { resolve })).resolves.toBeUndefined();
		await expect(assertSafeRemoteUrl("git@github.com:org/r.git", { resolve })).resolves.toBeUndefined();
		await expect(assertSafeRemoteUrl("https://8.8.8.8/r.git", {})).resolves.toBeUndefined();
	});

	it("upstream remotes are https only", async () => {
		await reject("ssh://git@github.com/org/r.git", { httpsOnly: true });
		await reject("git@github.com:org/r.git", { httpsOnly: true });
	});

	it("allowLocal is an explicit opt-in", async () => {
		await reject("/tmp/x.git");
		await expect(assertSafeRemoteUrl("/tmp/x.git", { allowLocal: true })).resolves.toBeUndefined();
		await reject("--upload-pack=evil", { allowLocal: true });
	});

	it("classifies addresses", () => {
		expect(isBlockedAddress("8.8.8.8")).toBe(false);
		expect(isBlockedAddress("2606:4700::1111")).toBe(false);
		expect(isBlockedAddress("100.64.0.1")).toBe(true);
		expect(isBlockedAddress("0.0.0.0")).toBe(true);
		expect(isBlockedAddress("not-an-ip")).toBe(true);
	});
});

describe("workspaces", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld({ seed: false });
	});
	afterAll(() => w.stop());

	const create = (who: { token: string }, body: unknown, teamId = w.teamId) => w.t.api("POST", `/api/teams/${teamId}/workspaces`, { token: who.token, body });

	it("creates a bare repository on disk with the default branch and daily report defaults", async () => {
		const ws = (await w.t.api("GET", `/api/workspaces/${w.wsId}`, { token: w.alice.token })).data;
		expect(ws).toMatchObject({
			id: w.wsId,
			teamId: w.teamId,
			orgId: w.root.orgId,
			name: "app",
			defaultBranch: "main",
			dailyReportTime: "09:00",
			dailyReportTz: "Asia/Shanghai",
			dailyReportEnabled: true,
			upstreamUrl: null,
			hasUpstreamToken: false,
		});
		expect(ws.repoDir).toBeUndefined();
		expect(await gitOk(["--git-dir", w.repoPath, "rev-parse", "--is-bare-repository"])).toBe("true");
		expect(await gitOk(["--git-dir", w.repoPath, "symbolic-ref", "HEAD"])).toBe("refs/heads/main");
	});

	it("lists workspaces for team members only", async () => {
		const list = await w.t.api("GET", `/api/teams/${w.teamId}/workspaces`, { token: w.alice.token });
		expect(list.data.map((x: { name: string }) => x.name)).toContain("app");
		expect((await w.t.api("GET", `/api/teams/${w.teamId}/workspaces`, { token: w.carol.token })).status).toBe(404);
	});

	it("permission matrix: team admin, org admin and operator create; reviewer, member and outsiders cannot", async () => {
		expect((await create(w.alice, { name: "by-member" })).status).toBe(403);
		expect((await create(w.bob, { name: "by-reviewer" })).status).toBe(403);
		expect((await create(w.carol, { name: "by-outsider" })).status).toBe(404);
		expect((await create(w.dan, { name: "by-team-admin" })).status).toBe(201);
		expect((await create(w.root, { name: "by-org-owner" })).status).toBe(201);

		const orgAdmin = await w.t.createUser(w.root.token, "olga@corp.test", "Olga", w.root.orgId);
		await w.t.api("PUT", `/api/orgs/${w.root.orgId}/members/${orgAdmin.userId}`, { token: w.root.token, body: { role: "admin" } });
		expect((await create(orgAdmin, { name: "by-org-admin" })).status).toBe(201);

		// Another organization's admin cannot even see the team.
		const other = await w.t.api("POST", "/api/orgs", { token: w.root.token, body: { name: "Other Corp" } });
		const outsider = await w.t.createUser(w.root.token, "otto@other.test", "Otto", other.data.id);
		await w.t.api("PUT", `/api/orgs/${other.data.id}/members/${outsider.userId}`, { token: w.root.token, body: { role: "admin" } });
		expect((await create(outsider, { name: "by-foreign-admin" })).status).toBe(404);
		expect((await w.t.api("GET", `/api/workspaces/${w.wsId}`, { token: outsider.token })).status).toBe(404);
	});

	it("rejects duplicate names within a team and invalid input", async () => {
		expect((await create(w.dan, { name: "app" })).code).toBe("workspaceNameTaken");
		expect((await create(w.dan, { name: "" })).code).toBe("validationError");
		expect((await create(w.dan, { name: "x", upstreamToken: "tok" })).code).toBe("validationError");
	});

	it("rejects unsafe import and upstream URLs even for team admins (default options)", async () => {
		const strict = await setupWorld({ seed: false, hub: { allowLocalGitRemotes: false } });
		try {
			const post = (body: unknown) => strict.t.api("POST", `/api/teams/${strict.teamId}/workspaces`, { token: strict.dan.token, body });
			for (const importUrl of ["file:///etc", "https://127.0.0.1/x.git", "http://example.com/x.git"]) {
				const r = await post({ name: "bad-import", importUrl });
				expect(r.status).toBe(400);
				expect(r.code).toBe("unsafeUrl");
			}
			expect((await post({ name: "bad-upstream", upstreamUrl: "http://example.com/x.git" })).code).toBe("unsafeUrl");
			const patched = await strict.t.api("PATCH", `/api/workspaces/${strict.wsId}`, { token: strict.dan.token, body: { upstreamUrl: "http://example.com/r.git" } });
			expect(patched.code).toBe("unsafeUrl");
			expect(await strict.t.hub.db.query("SELECT 1 FROM workspaces WHERE name LIKE 'bad-%'")).toHaveLength(0);
		} finally {
			await strict.stop();
		}
	});

	it("imports an existing repository (local paths only with the test option) and adopts its default branch", async () => {
		const src = await tmp("import-src-");
		await gitOk(["init", "-q", "-b", "trunk"], { cwd: src });
		await writeFiles(src, { "a.txt": "imported\n" });
		await commitAll(src, "first");
		const r = await create(w.dan, { name: "imported", importUrl: src });
		expect(r.status).toBe(201);
		expect(r.data.defaultBranch).toBe("trunk");
		const repo = `${w.t.dataDir}/repos/${r.data.id}.git`;
		expect(await gitOk(["--git-dir", repo, "show", "trunk:a.txt"])).toBe("imported");
		// No remote URL stays on disk.
		expect(await gitOk(["--git-dir", repo, "config", "--get-regexp", "^remote\\."]).catch(() => "")).toBe("");

		// Without the test option the same URL is refused.
		const strict = await setupWorld({ seed: false, hub: { allowLocalGitRemotes: false } });
		try {
			expect((await strict.t.api("POST", `/api/teams/${strict.teamId}/workspaces`, { token: strict.dan.token, body: { name: "x", importUrl: src } })).code).toBe("unsafeUrl");
		} finally {
			await strict.stop();
		}
	});

	it("a failed import leaves no workspace row or directory behind", async () => {
		const r = await create(w.dan, { name: "broken-import", importUrl: `${w.t.dataDir}/does-not-exist.git` });
		expect(r.code).toBe("importFailed");
		expect(await w.t.hub.db.query("SELECT 1 FROM workspaces WHERE name = 'broken-import'")).toHaveLength(0);
	});

	it("PATCH is for team admins: name, daily report settings, upstream", async () => {
		const patch = (who: { token: string }, body: unknown) => w.t.api("PATCH", `/api/workspaces/${w.wsId}`, { token: who.token, body });
		expect((await patch(w.alice, { name: "nope" })).status).toBe(403);
		expect((await patch(w.bob, { name: "nope" })).status).toBe(403);
		expect((await patch(w.carol, { name: "nope" })).status).toBe(404);

		const ok = await patch(w.dan, { name: "app2", dailyReportTime: "18:30", dailyReportTz: "UTC", dailyReportEnabled: false });
		expect(ok.status).toBe(200);
		expect(ok.data).toMatchObject({ name: "app2", dailyReportTime: "18:30", dailyReportTz: "UTC", dailyReportEnabled: false });
		expect((await patch(w.dan, { dailyReportTime: "25:00" })).code).toBe("validationError");
		expect((await patch(w.dan, { dailyReportTz: "Mars/Base" })).code).toBe("validationError");
		expect((await patch(w.dan, {})).code).toBe("validationError");
		expect((await patch(w.dan, { name: "app" })).data.name).toBe("app");
	});

	it("stores the upstream token sealed and never returns it", async () => {
		const created = await create(w.dan, { name: "with-upstream", upstreamUrl: "https://8.8.8.8/org/r.git", upstreamToken: "secret-token-123" });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ upstreamUrl: "https://8.8.8.8/org/r.git", hasUpstreamToken: true, upstreamStatus: null });
		expect(JSON.stringify(created.body)).not.toContain("secret-token-123");
		const rows = await w.t.hub.db.query<{ upstream_token_enc: string }>("SELECT upstream_token_enc FROM workspaces WHERE id = $1", [created.data.id]);
		expect(rows[0]?.upstream_token_enc).toMatch(/^v1:/);
		expect(rows[0]?.upstream_token_enc).not.toContain("secret-token-123");

		const removed = await w.t.api("PATCH", `/api/workspaces/${created.data.id}`, { token: w.dan.token, body: { upstreamUrl: null } });
		expect(removed.data).toMatchObject({ upstreamUrl: null, hasUpstreamToken: false });
	});

	it("writes audit entries for creation and updates", async () => {
		const audit = await w.t.hub.db.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'workspace.%'");
		expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["workspace.create", "workspace.update"]));
	});
});

describe("workspace file browsing", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld({ seed: { "README.md": "# hi\n", "docs/guide.md": "guide\n", "docs/img/logo.bin": Buffer.from([0, 255, 0, 1]), "big.dat": Buffer.alloc(5 * 1024 * 1024 + 1, 1) } });
	});
	afterAll(() => w.stop());

	const files = (who: { token: string }, query: string) => w.t.api("GET", `/api/workspaces/${w.wsId}/files${query}`, { token: who.token });

	it("lists the root directory of the default branch", async () => {
		const r = await files(w.alice, "");
		expect(r.data.type).toBe("dir");
		expect(r.data.ref).toBe("main");
		expect(r.data.entries).toEqual(
			expect.arrayContaining([
				{ name: "README.md", type: "file", size: 5 },
				{ name: "docs", type: "dir", size: null },
			]),
		);
	});

	it("lists subdirectories and returns file content as base64 with a binary flag", async () => {
		const dir = await files(w.alice, "?path=docs");
		expect(dir.data.entries.map((e: { name: string }) => e.name).sort()).toEqual(["guide.md", "img"]);
		const text = await files(w.alice, "?path=docs/guide.md&ref=main");
		expect(text.data).toMatchObject({ type: "file", size: 6, binary: false, encoding: "base64" });
		expect(Buffer.from(text.data.content, "base64").toString()).toBe("guide\n");
		const bin = await files(w.alice, "?path=/docs/img/logo.bin/");
		expect(bin.data.binary).toBe(true);
		expect([...Buffer.from(bin.data.content, "base64")]).toEqual([0, 255, 0, 1]);
	});

	it("serves session branches and snapshot refs for spectating", async () => {
		const dir = await tmp();
		await gitOk(["clone", "-q", w.gitUrl, dir], { token: w.alice.token });
		await gitOk(["checkout", "-q", "-b", `session/${w.alice.userId}/s9`], { cwd: dir });
		await writeFiles(dir, { "wip.txt": "wip\n" });
		const head = await commitAll(dir, "wip");
		await gitOk(["push", "-q", "origin", `HEAD:refs/prometheus/snapshots/${w.alice.userId}/s9`], { cwd: dir, token: w.alice.token });
		const snap = await files(w.bob, `?ref=refs/prometheus/snapshots/${w.alice.userId}/s9&path=wip.txt`);
		expect(snap.data.commit).toBe(head);
		expect(Buffer.from(snap.data.content, "base64").toString()).toBe("wip\n");
		expect((await files(w.bob, "?path=wip.txt")).status).toBe(404);
	});

	it("enforces the size cap, path rules, ref rules and membership", async () => {
		const big = await files(w.alice, "?path=big.dat");
		expect(big.status).toBe(413);
		expect(big.code).toBe("fileTooLarge");
		expect((await files(w.alice, "?path=docs/../../etc")).code).toBe("invalidPath");
		expect((await files(w.alice, "?path=a%5Cb")).code).toBe("invalidPath");
		expect((await files(w.alice, "?ref=--upload-pack=x")).code).toBe("invalidRef");
		expect((await files(w.alice, "?ref=a..b")).code).toBe("invalidRef");
		expect((await files(w.alice, "?ref=nosuch")).status).toBe(404);
		expect((await files(w.alice, "?path=nosuch.txt")).status).toBe(404);
		expect((await files(w.carol, "")).status).toBe(404);
		expect((await w.t.api("GET", `/api/workspaces/${w.wsId}/files`)).status).toBe(401);
	});

	it("an empty repository has no default branch to browse", async () => {
		const empty = await setupWorld({ seed: false });
		try {
			expect((await empty.t.api("GET", `/api/workspaces/${empty.wsId}/files`, { token: empty.alice.token })).status).toBe(404);
		} finally {
			await empty.stop();
		}
	});
});
