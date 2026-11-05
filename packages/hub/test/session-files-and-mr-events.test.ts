import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitAll, gitOk, openMr, sessionBranch, setupWorld, type World, writeFiles } from "./git-helpers.ts";
import { connectWs } from "./s-helpers.ts";

const T = 90_000;

let w: World;
beforeAll(async () => {
	w = await setupWorld();
	// startHub's server has no upgrade listener; the Hub installs its WebSocket handler through deps.setUpgradeHandler.
	w.t.server.on("upgrade", (req, socket, head) => {
		if (!w.t.hub.handleUpgrade(req, socket, head)) socket.destroy();
	});
}, T);
afterAll(async () => {
	w.t.server.closeAllConnections();
	await w.stop();
});

describe("GET /api/sessions/:id/files", () => {
	it("reads the branch head before the first snapshot and the snapshot afterwards; outsiders get nothing", async () => {
		const s = await sessionBranch(w, w.alice, "files1", { "docs/note.txt": "committed\n" });
		const reg = await w.t.api("POST", `/api/workspaces/${w.wsId}/sessions`, {
			token: w.alice.token,
			body: { localSessionId: "local-files-1", serverId: "srv", title: "files", branch: s.branch, baseCommit: s.base },
		});
		expect(reg.status).toBe(201);
		const id = reg.data.session?.id ?? reg.data.id;

		const root = await w.t.api("GET", `/api/sessions/${id}/files`, { token: w.bob.token });
		expect(root.status).toBe(200);
		expect(root.data.type).toBe("dir");
		expect(root.data.entries.map((e: { name: string }) => e.name)).toContain("docs");

		// A snapshot with uncommitted-looking extra work becomes the reference.
		await writeFiles(s.dir, { "docs/wip.txt": "work in progress\n" });
		const snapshot = await commitAll(s.dir, "snapshot");
		await gitOk(["push", "-q", "origin", `${snapshot}:refs/prometheus/snapshots/${w.alice.userId}/${id}`], { cwd: s.dir, token: w.alice.token });
		const patched = await w.t.api("PATCH", `/api/sessions/${id}`, { token: w.alice.token, body: { snapshotCommit: snapshot } });
		expect(patched.status).toBe(200);

		const file = await w.t.api("GET", `/api/sessions/${id}/files?path=docs/wip.txt`, { token: w.bob.token });
		expect(file.status).toBe(200);
		expect(file.data.type).toBe("file");
		expect(Buffer.from(file.data.content, "base64").toString("utf8")).toBe("work in progress\n");
		expect(file.data.commit).toBe(snapshot);

		// Carol belongs to the organization but not the team.
		const denied = await w.t.api("GET", `/api/sessions/${id}/files`, { token: w.carol.token });
		expect([403, 404]).toContain(denied.status);
	});
});

describe("merge request realtime events", () => {
	it("publishes every change to workspace:<id>", async () => {
		const bob = await connectWs(w.t.baseUrl, w.bob.token);
		expect(await bob.subscribe(`workspace:${w.wsId}`)).toMatchObject({ type: "subscribed" });

		const s = await sessionBranch(w, w.alice, "mr-events", { "mr-events.txt": "x\n" });
		const created = await openMr(w, w.alice, s, {}, "Events");
		expect(created.status).toBe(201);
		const mrId = created.data.id as string;

		const open = await bob.waitFor((f) => f.type === "event" && f.data?.kind === "mergeRequest" && f.data.mergeRequest.id === mrId);
		expect(open.topic).toBe(`workspace:${w.wsId}`);
		expect(open.data.mergeRequest.status).toBe("open");

		const approved = await w.t.api("POST", `/api/merge-requests/${mrId}/approve`, { token: w.bob.token, body: { expectedHeadCommit: created.data.headCommit } });
		expect(approved.status).toBe(200);
		const merged = await bob.waitFor((f) => f.type === "event" && f.data?.kind === "mergeRequest" && f.data.mergeRequest.id === mrId && f.data.mergeRequest.status === "merged");
		expect(merged.data.mergeRequest.mergedCommit).toBeTruthy();

		const s2 = await sessionBranch(w, w.alice, "mr-events-2", { "other.txt": "y\n" });
		const second = await openMr(w, w.alice, s2, {}, "Second");
		const secondId = second.data.id as string;
		await bob.waitFor((f) => f.type === "event" && f.data?.mergeRequest?.id === secondId && f.data.mergeRequest.status === "open");
		const closed = await w.t.api("POST", `/api/merge-requests/${secondId}/close`, { token: w.alice.token });
		expect(closed.status).toBe(200);
		await bob.waitFor((f) => f.type === "event" && f.data?.mergeRequest?.id === secondId && f.data.mergeRequest.status === "closed");
		await bob.close();
	});
});
