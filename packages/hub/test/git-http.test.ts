import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firstForbiddenCommand, isPushableRef, parseReceivePackCommands, ZERO_OID } from "../src/git/pktline.ts";
import { commitAll, git, gitOk, sessionBranch, setupWorld, tmp, type World, writeFiles } from "./git-helpers.ts";

const pkt = (s: string): Buffer => Buffer.from(`${(s.length + 4).toString(16).padStart(4, "0")}${s}`);
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

describe("receive-pack command parsing", () => {
	it("parses commands with capabilities and waits for the flush packet", () => {
		const first = pkt(`${ZERO_OID} ${OID_A} refs/heads/session/u1/s1\0report-status side-band-64k`);
		const second = pkt(`${OID_A} ${OID_B} refs/prometheus/snapshots/u1/s1`);
		expect(parseReceivePackCommands(Buffer.concat([first, second])).kind).toBe("incomplete");
		const done = parseReceivePackCommands(Buffer.concat([first, second, Buffer.from("0000"), Buffer.from("PACK...")]));
		expect(done).toMatchObject({ kind: "done", commands: [{ ref: "refs/heads/session/u1/s1" }, { ref: "refs/prometheus/snapshots/u1/s1" }] });
		if (done.kind === "done") expect(done.consumed).toBe(first.length + second.length + 4);
	});

	it("rejects malformed framing and push certificates", () => {
		expect(parseReceivePackCommands(Buffer.from("zzzz")).kind).toBe("invalid");
		expect(parseReceivePackCommands(pkt("only-two parts")).kind).toBe("invalid");
		expect(parseReceivePackCommands(pkt("push-cert\0caps")).kind).toBe("invalid");
	});

	it("only allows the user's own session and snapshot namespaces", () => {
		expect(isPushableRef("refs/heads/session/u1/s1", "u1")).toBe(true);
		expect(isPushableRef("refs/heads/session/u1/a/b", "u1")).toBe(true);
		expect(isPushableRef("refs/prometheus/snapshots/u1/s1", "u1")).toBe(true);
		expect(isPushableRef("refs/heads/main", "u1")).toBe(false);
		expect(isPushableRef("refs/heads/session/u2/s1", "u1")).toBe(false);
		expect(isPushableRef("refs/heads/session/u1/", "u1")).toBe(false);
		expect(isPushableRef("refs/heads/session/u1/../../main", "u1")).toBe(false);
		expect(isPushableRef("refs/heads/session/u1x/s1", "u1")).toBe(false);
		expect(isPushableRef("refs/tags/session/u1/s1", "u1")).toBe(false);
		expect(firstForbiddenCommand([{ oldOid: OID_A, newOid: OID_B, ref: "refs/heads/main" }], "u1")?.ref).toBe("refs/heads/main");
	});
});

describe("git smart HTTP", () => {
	let w: World;
	beforeAll(async () => {
		w = await setupWorld();
	});
	afterAll(() => w.stop());

	it("clones with a Bearer token and with Basic credentials (token as password)", async () => {
		const a = await tmp();
		await gitOk(["clone", "-q", w.gitUrl, a], { token: w.alice.token });
		expect(await gitOk(["show", "HEAD:README.md"], { cwd: a })).toBe("# project");

		const b = await tmp();
		const url = new URL(w.gitUrl);
		url.username = "anyone";
		url.password = w.bob.token;
		await gitOk(["clone", "-q", url.toString(), b]);
		expect(await gitOk(["rev-parse", "HEAD"], { cwd: b })).toBe(await gitOk(["rev-parse", "HEAD"], { cwd: a }));
	});

	it("rejects missing or invalid credentials with a Basic challenge", async () => {
		const noAuth = await fetch(`${w.gitUrl}/info/refs?service=git-upload-pack`);
		expect(noAuth.status).toBe(401);
		expect(noAuth.headers.get("www-authenticate")).toMatch(/^Basic/);
		const bad = await fetch(`${w.gitUrl}/info/refs?service=git-upload-pack`, { headers: { authorization: "Bearer not.a.token" } });
		expect(bad.status).toBe(401);
		const r = await git(["clone", "-q", w.gitUrl, await tmp()]);
		expect(r.code).not.toBe(0);
	});

	it("hides the repository from users outside the team and from unknown ids", async () => {
		const carolRes = await fetch(`${w.gitUrl}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${w.carol.token}` } });
		expect(carolRes.status).toBe(404);
		const unknown = await fetch(`${w.t.baseUrl}/git/nonexistent.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${w.alice.token}` } });
		expect(unknown.status).toBe(404);
		const operator = await fetch(`${w.gitUrl}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${w.root.token}` } });
		expect(operator.status).toBe(200);
	});

	it("only serves the smart protocol", async () => {
		const headers = { authorization: `Bearer ${w.alice.token}` };
		expect((await fetch(`${w.gitUrl}/HEAD`, { headers })).status).toBe(404);
		expect((await fetch(`${w.gitUrl}/objects/info/packs`, { headers })).status).toBe(404);
		expect((await fetch(`${w.gitUrl}/info/refs`, { headers })).status).toBe(404);
		expect((await fetch(`${w.gitUrl}/info/refs?service=git-bogus`, { headers })).status).toBe(404);
	});

	it("accepts pushes to the user's session branch and snapshot ref", async () => {
		const s = await sessionBranch(w, w.alice, "s1", { "feature.txt": "hello\n" });
		expect(await gitOk(["--git-dir", w.repoPath, "rev-parse", `refs/heads/${s.branch}`])).toBe(s.head);

		await writeFiles(s.dir, { "wip.txt": "uncommitted work\n" });
		const snap = await commitAll(s.dir, "snapshot");
		await gitOk(["push", "-q", "origin", `${snap}:refs/prometheus/snapshots/${w.alice.userId}/s1`], { cwd: s.dir, token: w.alice.token });
		expect(await gitOk(["--git-dir", w.repoPath, "rev-parse", `refs/prometheus/snapshots/${w.alice.userId}/s1`])).toBe(snap);

		// Force-push (rebase) to the own session branch and deleting it are fine too.
		await gitOk(["push", "-q", "-f", "origin", `${snap}:refs/heads/${s.branch}`], { cwd: s.dir, token: w.alice.token });
		await gitOk(["push", "-q", "origin", `:refs/heads/${s.branch}`], { cwd: s.dir, token: w.alice.token });
		expect((await git(["--git-dir", w.repoPath, "rev-parse", "--verify", "-q", `refs/heads/${s.branch}`])).code).not.toBe(0);
	});

	it("rejects pushes to the default branch with 403", async () => {
		const dir = await tmp();
		await gitOk(["clone", "-q", w.gitUrl, dir], { token: w.alice.token });
		const before = await gitOk(["--git-dir", w.repoPath, "rev-parse", "refs/heads/main"]);
		await writeFiles(dir, { "sneaky.txt": "x\n" });
		await commitAll(dir, "direct to main");
		const r = await git(["push", "origin", "HEAD:refs/heads/main"], { cwd: dir, token: w.alice.token });
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/403/);
		expect(await gitOk(["--git-dir", w.repoPath, "rev-parse", "refs/heads/main"])).toBe(before);

		// Even reviewers and admins cannot push the default branch; the same goes for other users' namespaces and tags.
		const admin = await git(["push", "origin", "HEAD:refs/heads/main"], { cwd: dir, token: w.dan.token });
		expect(admin.stderr).toMatch(/403/);
		const foreign = await git(["push", "origin", `HEAD:refs/heads/session/${w.bob.userId}/x`], { cwd: dir, token: w.alice.token });
		expect(foreign.stderr).toMatch(/403/);
		const tag = await git(["push", "origin", "HEAD:refs/tags/v1"], { cwd: dir, token: w.alice.token });
		expect(tag.stderr).toMatch(/403/);
		// A mixed push is refused as a whole.
		const mixed = await git(["push", "origin", `HEAD:refs/heads/session/${w.alice.userId}/ok`, "HEAD:refs/heads/main"], { cwd: dir, token: w.alice.token });
		expect(mixed.code).not.toBe(0);
		expect((await git(["--git-dir", w.repoPath, "rev-parse", "--verify", "-q", `refs/heads/session/${w.alice.userId}/ok`])).code).not.toBe(0);
	});

	it("applies the push rules to gzip-encoded request bodies", async () => {
		const body = Buffer.concat([pkt(`${ZERO_OID} ${OID_A} refs/heads/main\0report-status`), Buffer.from("0000")]);
		const res = await fetch(`${w.gitUrl}/git-receive-pack`, {
			method: "POST",
			headers: { authorization: `Bearer ${w.alice.token}`, "content-type": "application/x-git-receive-pack-request", "content-encoding": "gzip" },
			body: gzipSync(body),
		});
		expect(res.status).toBe(403);
		const bad = await fetch(`${w.gitUrl}/git-receive-pack`, {
			method: "POST",
			headers: { authorization: `Bearer ${w.alice.token}`, "content-type": "application/x-git-receive-pack-request" },
			body: Buffer.from("garbage!"),
		});
		expect(bad.status).toBe(400);
	});

	it("streams a multi-megabyte push and a fresh clone of it", async () => {
		const dir = await tmp();
		await gitOk(["clone", "-q", w.gitUrl, dir], { token: w.alice.token });
		const branch = `session/${w.alice.userId}/big`;
		await gitOk(["checkout", "-q", "-b", branch], { cwd: dir });
		await writeFiles(dir, { "big.bin": randomBytes(6 * 1024 * 1024), "big2.bin": randomBytes(3 * 1024 * 1024) });
		const head = await commitAll(dir, "big");
		await gitOk(["push", "-q", "origin", `HEAD:refs/heads/${branch}`], { cwd: dir, token: w.alice.token });
		expect(await gitOk(["--git-dir", w.repoPath, "rev-parse", `refs/heads/${branch}`])).toBe(head);

		const copy = await tmp();
		await gitOk(["clone", "-q", "--branch", branch, w.gitUrl, copy], { token: w.bob.token });
		expect(await gitOk(["rev-parse", "HEAD"], { cwd: copy })).toBe(head);
		await gitOk(["fsck", "--no-progress"], { cwd: copy });
	});

	it("supports protocol v2 fetches and incremental fetch", async () => {
		const dir = await tmp();
		await gitOk(["clone", "-q", w.gitUrl, dir], { token: w.alice.token, env: { GIT_TRACE_PACKET: "0" } });
		const s = await sessionBranch(w, w.bob, "incr", { "bob.txt": "b\n" });
		await gitOk(["fetch", "-q", "origin"], { cwd: dir, token: w.alice.token });
		expect(await gitOk(["rev-parse", `origin/${s.branch}`], { cwd: dir })).toBe(s.head);
	});
});
