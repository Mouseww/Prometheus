import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Member, startMember, startTeamWorld, type TeamWorld } from "./harness.ts";

const T = 120_000;
vi.setConfig({ testTimeout: T });

let tw: TeamWorld;
let alice: Member;

beforeAll(async () => {
	tw = await startTeamWorld();
	alice = await startMember(tw, "alice@corp.test");
}, T);
afterAll(async () => {
	await alice.stop();
	await tw.stop();
});

const start = async (title: string) => (await alice.ctx.call("session.start", { workspaceId: tw.world.wsId, title })) as { sessionId: string; hubSessionId: string };

describe("session.link", () => {
	it("answers the Hub session of a team session, with the mode from the Hub", async () => {
		const s = await start("link plain");
		expect(await alice.ctx.call("session.link", { sessionId: s.sessionId })).toEqual({
			hubSessionId: s.hubSessionId,
			workspaceId: tw.world.wsId,
			readOnly: false,
			activeSide: "local",
			execMode: expect.stringMatching(/^(local|team)-first$/),
		});
	});

	it("reports a mirror that moved to the other side and the copy that took over", async () => {
		const s = await start("link mirror");
		await alice.api.state.update((st) => {
			const cur = st.sessions[s.sessionId]!;
			return { ...st, sessions: { ...st.sessions, [s.sessionId]: { ...cur, readOnly: { to: "team" as const, activeSessionId: "tenant-1" } } } };
		});
		expect(await alice.ctx.call("session.link", { sessionId: s.sessionId })).toMatchObject({ hubSessionId: s.hubSessionId, readOnly: true, activeSide: "team", activeSessionId: "tenant-1" });
	});

	it("answers null for a session that is not a team session and validates the parameter", async () => {
		expect(await alice.ctx.call("session.link", { sessionId: "not-a-team-session" })).toBeNull();
		await expect(alice.ctx.call("session.link", {})).rejects.toMatchObject({ code: "invalidParams" });
	});

	it("still answers from local state when the Hub cannot be reached", async () => {
		const s = await start("link offline");
		const spy = vi.spyOn(alice.api.client, "call").mockRejectedValue(new Error("hub down"));
		try {
			const info = (await alice.ctx.call("session.link", { sessionId: s.sessionId })) as Record<string, unknown>;
			expect(info).toMatchObject({ hubSessionId: s.hubSessionId, readOnly: false, activeSide: "local" });
			expect(info).not.toHaveProperty("execMode");
		} finally {
			spy.mockRestore();
		}
	});
});
