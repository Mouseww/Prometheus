import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantCredentials } from "../../../packages/hub/src/auth/tenant-credentials.ts";
import { actOnSession, readOnlyGuard } from "../src/handoff/index.ts";
import { executeRelay } from "../src/member/relay.ts";
import { type Member, startMember, startTeamWorld, type TeamWorld, waitFor } from "./harness.ts";

const T = 180_000;
vi.setConfig({ testTimeout: T });

let tw: TeamWorld;
let local: Member;
let team: Member;

// The Hub only accepts tenant credentials it issued (jti recorded), so go through the credential service.
const tenantToken = async (): Promise<string> => {
	const creds = tw.world.t.hub.registry.require<TenantCredentials>("tenantCredentials");
	return (await creds.issue(tw.world.alice.userId, "tenant", 3600)).token;
};

beforeAll(async () => {
	tw = await startTeamWorld();
	local = await startMember(tw, "alice@corp.test");
	// A tenant instance of alice: connects with the tenant credential as the `tenant` kind.
	team = await startMember(tw, "alice@corp.test", { login: false, tenant: { hubUrl: tw.hubUrl, token: await tenantToken() } });
	await waitFor(() => local.api.socket.connected && team.api.socket.connected, "both sockets connected", 20_000);
}, T);
afterAll(async () => {
	await Promise.all([local.stop(), team.stop()]);
	await tw.stop();
});

const setHub = (hubSessionId: string, location: "local" | "team", tenantSessionId: string | null): Promise<unknown> =>
	tw.world.t.hub.db.query("UPDATE sessions SET exec_location = $2, tenant_session_id = $3 WHERE id = $1", [hubSessionId, location, tenantSessionId]);

const setReadOnly = (m: Member, sessionId: string, readOnly: { to: "local" | "team"; activeSessionId: string } | undefined) =>
	m.api.state.update((st) => {
		const cur = st.sessions[sessionId];
		if (!cur) return st;
		const { readOnly: _drop, ...rest } = cur;
		return { ...st, sessions: { ...st.sessions, [sessionId]: readOnly ? { ...rest, readOnly } : rest } };
	});

async function startPair(title: string) {
	const s = (await local.ctx.call("session.start", { workspaceId: tw.world.wsId, title })) as { sessionId: string; hubSessionId: string; worktree: string; branch: string };
	const tenantSessionId = `tenant-${s.sessionId}`;
	const mapping = local.api.state.get().sessions[s.sessionId]!;
	await team.api.state.update((st) => ({ ...st, sessions: { ...st.sessions, [tenantSessionId]: { ...mapping, worktree: s.worktree } } }));
	return { ...s, tenantSessionId };
}

describe("prompts, answers and aborts follow the active side", () => {
	it("owner's local client reaches the tenant session while the team side is active, and the reverse after handing back", async () => {
		const s = await startPair("active side");
		await setHub(s.hubSessionId, "team", s.tenantSessionId);
		await setReadOnly(local, s.sessionId, { to: "team", activeSessionId: s.tenantSessionId });
		const before = { local: local.ctx.calls.length, team: team.ctx.calls.length };

		expect(await local.ctx.call("session.act", { sessionId: s.sessionId, action: { type: "prompt", text: "continue on the team side" } })).toEqual({ routed: "hub" });
		expect(await local.ctx.call("session.act", { sessionId: s.sessionId, action: { type: "respond", requestId: "q1", response: { allow: true } } })).toEqual({ routed: "hub" });
		expect(await local.ctx.call("session.act", { sessionId: s.sessionId, action: { type: "abort" } })).toEqual({ routed: "hub" });
		await waitFor(() => team.ctx.calls.length >= before.team + 3, "three actions on the tenant");
		const got = team.ctx.calls.slice(before.team);
		expect(got.map((c) => c.kind)).toEqual(["prompt", "respond", "abort"]);
		expect(got.every((c) => c.sessionId === s.tenantSessionId)).toBe(true);
		expect(got[0]).toMatchObject({ text: "continue on the team side", actor: expect.any(String) });
		expect(got[1]).toMatchObject({ requestId: "q1", response: { allow: true } });
		expect(local.ctx.calls.length).toBe(before.local);

		// The brain moves home: the tenant copy retires and its client now reaches the local session.
		await setHub(s.hubSessionId, "local", s.tenantSessionId);
		await setReadOnly(local, s.sessionId, undefined);
		await setReadOnly(team, s.tenantSessionId, { to: "local", activeSessionId: s.sessionId });
		const mark = { local: local.ctx.calls.length, team: team.ctx.calls.length };
		expect(await team.ctx.call("session.act", { sessionId: s.tenantSessionId, action: { type: "prompt", text: "back home" } })).toEqual({ routed: "hub" });
		await waitFor(() => local.ctx.calls.length > mark.local, "prompt on the local session");
		expect(local.ctx.calls.at(-1)).toMatchObject({ kind: "prompt", sessionId: s.sessionId, text: "back home" });
		expect(team.ctx.calls.length).toBe(mark.team);
	});

	it("runs the action here when this copy is the live one", async () => {
		const s = await startPair("live copy");
		const before = local.ctx.calls.length;
		expect(await local.ctx.call("session.act", { sessionId: s.sessionId, action: { type: "prompt", text: "plain" } })).toEqual({ routed: "local" });
		expect(local.ctx.calls.slice(before)).toEqual([{ kind: "prompt", sessionId: s.sessionId, text: "plain" }]);
		await expect(local.ctx.call("session.act", { sessionId: "unknown", action: { type: "abort" } })).rejects.toMatchObject({ code: "notTeamSession" });
		await expect(local.ctx.call("session.act", { sessionId: s.sessionId, action: { type: "prompt", text: " " } })).rejects.toMatchObject({ code: "invalidAction" });
	});

	it("surfaces the Hub's refusal when the active side is not connected", async () => {
		const s = await startPair("offline target");
		await setHub(s.hubSessionId, "team", null);
		await setReadOnly(local, s.sessionId, { to: "team", activeSessionId: "x" });
		await expect(actOnSession(local.api.env, local.ctx.sessions, { sessionId: s.sessionId, action: { type: "prompt", text: "hi" } })).rejects.toBeDefined();
		await setHub(s.hubSessionId, "local", null);
	});

	it("never runs a relayed action on a retired copy", async () => {
		const s = await startPair("stale route");
		await setReadOnly(local, s.sessionId, { to: "team", activeSessionId: "x" });
		const before = local.ctx.calls.length;
		await expect(
			executeRelay(local.api.env, local.ctx.sessions, { type: "relay", relayId: "r", hubSessionId: s.hubSessionId, sessionId: s.sessionId, action: { type: "prompt", text: "stale" } }),
		).rejects.toMatchObject({ code: "sessionReadOnly" });
		expect(local.ctx.calls.length).toBe(before);
	});

	it("the input guard forwards a prompt typed into a retired copy and tells the user", async () => {
		const s = await startPair("guard forward");
		await setHub(s.hubSessionId, "team", s.tenantSessionId);
		await setReadOnly(local, s.sessionId, { to: "team", activeSessionId: s.tenantSessionId });
		const handlers: Record<string, (event: unknown, ctx: unknown) => { action: string }> = {};
		readOnlyGuard(local.api.env)({ on: (name: string, fn: never) => void (handlers[name] = fn) } as never);
		const notices: string[] = [];
		const ectx = { sessionManager: { getSessionId: () => s.sessionId }, ui: { notify: (m: string) => void notices.push(m) } };
		const before = team.ctx.calls.length;
		expect(handlers.input!({ text: "typed locally" }, ectx)).toEqual({ action: "handled" });
		await waitFor(() => team.ctx.calls.length > before, "forwarded prompt");
		expect(team.ctx.calls.at(-1)).toMatchObject({ kind: "prompt", sessionId: s.tenantSessionId, text: "typed locally" });
		await waitFor(() => notices.length > 0, "notice");
		expect(notices[0]).toContain("已转发");

		// Nothing to forward to: the user is told to continue on the other side.
		await setHub(s.hubSessionId, "team", null);
		notices.length = 0;
		handlers.input!({ text: "nowhere" }, ectx);
		await waitFor(() => notices.length > 0, "failure notice");
		expect(notices[0]).toContain("转发失败");
		await setHub(s.hubSessionId, "local", null);
	});
});
