import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Handoff, readOnlyGuard, setupHandoff } from "../src/handoff/index.ts";
import type { MemberEnv } from "../src/member/env.ts";
import { TurnUploader } from "../src/member/turn-upload.ts";
import { SyncManager } from "../src/sync/manager.ts";
import { type Member, socketPair, startMember, startTeamWorld, type TeamWorld, waitFor } from "./harness.ts";

const T = 180_000;
vi.setConfig({ testTimeout: T });

let tw: TeamWorld;
let local: Member;
let team: Member;

beforeAll(async () => {
	tw = await startTeamWorld();
	local = await startMember(tw, "alice@corp.test");
	team = await startMember(tw, "alice@corp.test");
}, T);
afterAll(async () => {
	await Promise.all([local.stop(), team.stop()]);
	await tw.stop();
});

const norm = (s: string): string => s.replace(/\r\n/g, "\n");
const TRANSCRIPT = `${JSON.stringify({ type: "session", id: "t1" })}\n`;

interface Sides {
	localHandoff: Handoff;
	teamHandoff: Handoff;
	localSync: SyncManager;
	teamSync: SyncManager;
	teamEnv: MemberEnv;
	badges: { side: string; sessionId: string; text: string }[];
	notes: { side: string; topic: string; data: any }[];
	sockets: ReturnType<typeof socketPair>;
	stop(): void;
}

function sides(): Sides {
	const sockets = socketPair();
	const badges: Sides["badges"] = [];
	const notes: Sides["notes"] = [];
	const teamEnv: MemberEnv = { ...team.api.env, side: "team" };
	const localSync = new SyncManager(local.api.env, { socket: sockets.a, notify: () => {}, barrierMs: 5000 });
	const teamSync = new SyncManager(teamEnv, { socket: sockets.b, notify: () => {}, barrierMs: 5000 });
	local.ctx.sessions.setBadge = async (sessionId, badge) => void badges.push({ side: "local", sessionId, text: badge?.text ?? "" });
	team.ctx.sessions.setBadge = async (sessionId, badge) => void badges.push({ side: "team", sessionId, text: badge?.text ?? "" });
	const make = (env: MemberEnv, sync: SyncManager, side: string) =>
		new Handoff({ env, sync, mirror: { flush: async () => {} }, uploader: new TurnUploader(env), notify: (topic, data) => void notes.push({ side, topic, data }), abortWaitMs: 300 });
	return {
		localHandoff: make(local.api.env, localSync, "local"),
		teamHandoff: make(teamEnv, teamSync, "team"),
		localSync,
		teamSync,
		teamEnv,
		badges,
		notes,
		sockets,
		stop: () => (localSync.dispose(), teamSync.dispose()),
	};
}

async function startSession(title: string) {
	const s = (await local.ctx.call("session.start", { workspaceId: tw.world.wsId, title })) as { sessionId: string; hubSessionId: string; worktree: string; branch: string };
	local.ctx.transcripts.set(s.sessionId, TRANSCRIPT);
	// The Hub serves the transcript the target imports; `session.start` does not create one.
	return s;
}

describe("handoff between the local server and the tenant", () => {
	it("local to team and back: files, event numbering, read-only source and execChanged both ways", async () => {
		const s = await startSession("handoff roundtrip");
		const h = sides();
		try {
			await writeFile(join(s.worktree, "work.txt"), "from local\n");
			await local.api.state.update((st) => ({ ...st, sessions: { ...st.sessions, [s.sessionId]: { ...st.sessions[s.sessionId]!, nextSeq: 7 } } }));

			// local -> team
			const exported = await h.localHandoff.export({ hubSessionId: s.hubSessionId, sessionId: s.sessionId });
			expect(exported).toMatchObject({ snapshotCommit: expect.stringMatching(/^[0-9a-f]{40}$/), nextSeq: 7 });
			const imported = await h.teamHandoff.import({ hubSessionId: s.hubSessionId, title: "handoff roundtrip", ...exported });
			expect(imported.sessionId).toMatch(/^imported-/);
			const teamMapping = h.teamEnv.state.get().sessions[imported.sessionId]!;
			expect(teamMapping).toMatchObject({ hubSessionId: s.hubSessionId, nextSeq: 7 });
			expect(norm(await readFile(join(teamMapping.worktree, "work.txt"), "utf8"))).toBe("from local\n");
			expect(team.ctx.imported.at(-1)).toMatchObject({ cwd: teamMapping.worktree, sessionId: imported.sessionId });
			expect(h.badges).toContainEqual({ side: "team", sessionId: imported.sessionId, text: expect.stringContaining("团队 server") });
			expect(h.notes.find((n) => n.side === "team")).toMatchObject({ topic: "execChanged", data: { hubSessionId: s.hubSessionId, activeSide: "team", readOnly: false } });

			await h.localHandoff.finish({ hubSessionId: s.hubSessionId, sessionId: s.sessionId, activeSessionId: imported.sessionId, to: "team" });
			expect(local.api.state.get().sessions[s.sessionId]?.readOnly).toEqual({ to: "team", activeSessionId: imported.sessionId });
			expect(h.badges).toContainEqual({ side: "local", sessionId: s.sessionId, text: expect.stringContaining("团队 server") });
			expect(h.notes.find((n) => n.side === "local")).toMatchObject({ topic: "execChanged", data: { activeSide: "team", activeSessionId: imported.sessionId, readOnly: true } });

			// The retired source cannot be exported again, and the target cannot be imported twice.
			await expect(h.localHandoff.export({ hubSessionId: s.hubSessionId, sessionId: s.sessionId })).rejects.toMatchObject({ code: "sessionReadOnly" });
			await expect(h.teamHandoff.import({ hubSessionId: s.hubSessionId })).rejects.toMatchObject({ code: "alreadyActive" });

			// team -> local: the team side works, then the brain moves home.
			await writeFile(join(teamMapping.worktree, "work.txt"), "edited in team\n");
			await writeFile(join(teamMapping.worktree, "new.txt"), "team only\n");
			team.ctx.transcripts.set(imported.sessionId, TRANSCRIPT);
			const back = await h.teamHandoff.export({ hubSessionId: s.hubSessionId, sessionId: imported.sessionId });
			const home = await h.localHandoff.import({ hubSessionId: s.hubSessionId, title: "handoff roundtrip", ...back });
			expect(home.sessionId).not.toBe(s.sessionId);
			const homeMapping = local.api.state.get().sessions[home.sessionId]!;
			expect(homeMapping.readOnly).toBeUndefined();
			expect(homeMapping.worktree).toBe(s.worktree);
			expect(norm(await readFile(join(s.worktree, "work.txt"), "utf8"))).toBe("edited in team\n");
			expect(norm(await readFile(join(s.worktree, "new.txt"), "utf8"))).toBe("team only\n");
			await h.teamHandoff.finish({ hubSessionId: s.hubSessionId, sessionId: imported.sessionId, activeSessionId: home.sessionId, to: "local" });
			expect(h.teamEnv.state.get().sessions[imported.sessionId]?.readOnly).toEqual({ to: "local", activeSessionId: home.sessionId });
			// The old local mapping stays read-only and the new one is the live copy sync writes into.
			expect(local.api.state.get().sessions[s.sessionId]?.readOnly).toBeDefined();
			expect(h.localSync.target(s.hubSessionId)?.readOnly).toBe(false);
		} finally {
			h.stop();
		}
	});

	it("refuses to move a running session unless forced, and force aborts it first", async () => {
		const s = await startSession("handoff busy");
		const h = sides();
		const infoBefore = local.ctx.sessions.info;
		const abortBefore = local.ctx.sessions.abort;
		let running = true;
		let aborted = 0;
		local.ctx.sessions.info = (async () => ({ running })) as unknown as typeof local.ctx.sessions.info;
		local.ctx.sessions.abort = async () => void ((aborted += 1), (running = false));
		try {
			await expect(h.localHandoff.export({ hubSessionId: s.hubSessionId, sessionId: s.sessionId })).rejects.toMatchObject({ code: "agentBusy" });
			expect(aborted).toBe(0);
			const forced = await h.localHandoff.export({ hubSessionId: s.hubSessionId, sessionId: s.sessionId, force: true });
			expect(aborted).toBe(1);
			expect(forced.snapshotCommit).toMatch(/^[0-9a-f]{40}$/);

			running = true;
			local.ctx.sessions.abort = async () => void (aborted += 1);
			await expect(h.localHandoff.export({ hubSessionId: s.hubSessionId, sessionId: s.sessionId, force: true })).rejects.toMatchObject({ code: "agentBusy" });
		} finally {
			local.ctx.sessions.info = infoBefore;
			local.ctx.sessions.abort = abortBefore;
			h.stop();
		}
	});

	it("validates its parameters and the mapping", async () => {
		const h = sides();
		try {
			await expect(h.localHandoff.export({})).rejects.toMatchObject({ code: "invalidParams" });
			await expect(h.localHandoff.export({ hubSessionId: "h", sessionId: "nope" })).rejects.toMatchObject({ code: "notTeamSession" });
			await expect(h.localHandoff.finish({ hubSessionId: "h", sessionId: "nope", activeSessionId: "a" })).rejects.toMatchObject({ code: "notTeamSession" });
			await expect(h.localHandoff.run("handoff.unknown", {})).rejects.toMatchObject({ code: "unknownCommand" });
		} finally {
			h.stop();
		}
	});

	it("answers the Hub's cmd frames with cmdResult (ok and error)", async () => {
		const h = sides();
		const sockets = socketPair();
		const { off } = setupHandoff({ extension: () => {} }, { env: local.api.env, sync: h.localSync, mirror: { flush: async () => {} }, uploader: new TurnUploader(local.api.env), notify: () => {} }, sockets.a);
		const replies: Record<string, unknown>[] = [];
		sockets.b.onFrame((f) => void replies.push(f));
		try {
			sockets.b.sendFrame({ type: "cmd", cmdId: "c1", cmd: "handoff.export", params: { hubSessionId: "h", sessionId: "nope" } });
			sockets.b.sendFrame({ type: "cmd", cmdId: "c2", cmd: "nothing", params: {} });
			await waitFor(() => replies.length >= 2, "two replies");
			expect(replies.find((r) => r.cmdId === "c1")).toMatchObject({ type: "cmdResult", ok: false, code: "notTeamSession" });
			expect(replies.find((r) => r.cmdId === "c2")).toMatchObject({ type: "cmdResult", ok: false, code: "unknownCommand" });
		} finally {
			off();
			h.stop();
		}
	});
});

describe("read-only guard", () => {
	it("handles prompts of a retired session and lets everything else through", async () => {
		const s = await startSession("guard");
		const handlers: Record<string, (event: unknown, ctx: unknown) => { action: string }> = {};
		readOnlyGuard(local.api.env)({ on: (name: string, fn: never) => void (handlers[name] = fn) } as never);
		const notices: string[] = [];
		const ectx = (id: string) => ({ sessionManager: { getSessionId: () => id }, ui: { notify: (m: string) => void notices.push(m) } });

		expect(handlers.input!({ text: "hi" }, ectx(s.sessionId))).toEqual({ action: "continue" });
		await local.api.state.update((st) => ({ ...st, sessions: { ...st.sessions, [s.sessionId]: { ...st.sessions[s.sessionId]!, readOnly: { to: "team", activeSessionId: "x" } } } }));
		expect(handlers.input!({ text: "hi" }, ectx(s.sessionId))).toEqual({ action: "handled" });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("团队 server");
		expect(handlers.input!({ text: "hi" }, ectx("not-a-team-session"))).toEqual({ action: "continue" });
	});
});
