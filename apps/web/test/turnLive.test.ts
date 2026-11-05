import { describe, expect, it } from "vitest";
import { assistantTurnLive } from "../src/lib/turnLive.ts";

describe("assistantTurnLive", () => {
	it("does not treat the previous reply as live the moment a new prompt is sent", () => {
		// agent_start arrives while the last transcript item is still the previous assistant.
		expect(
			assistantTurnLive({
				streaming: true,
				pending: true,
				lastInGroup: 3,
				lastIndex: 3,
				lastNonResult: 3,
				stopReason: "stop",
			}),
		).toBe(false);
	});

	it("keeps a finished last reply folded even if streaming started without a pending bubble", () => {
		expect(
			assistantTurnLive({
				streaming: true,
				pending: false,
				lastInGroup: 3,
				lastIndex: 3,
				lastNonResult: 3,
				stopReason: "stop",
			}),
		).toBe(false);
	});

	it("keeps a finished turn folded while idle", () => {
		expect(
			assistantTurnLive({
				streaming: false,
				pending: false,
				lastInGroup: 3,
				lastIndex: 3,
				lastNonResult: 3,
				stopReason: "stop",
			}),
		).toBe(false);
	});

	it("marks the new assistant reply as live once it is in the transcript", () => {
		expect(
			assistantTurnLive({
				streaming: true,
				pending: false,
				lastInGroup: 5,
				lastIndex: 5,
				lastNonResult: 5,
				stopReason: "pending",
			}),
		).toBe(true);
	});

	it("does not reopen a previous turn that ended on a tool result when a new prompt is sent", () => {
		expect(
			assistantTurnLive({
				streaming: true,
				pending: true,
				lastInGroup: 4,
				lastIndex: 5,
				lastNonResult: 4,
				stopReason: "toolUse",
			}),
		).toBe(false);
	});

	it("stays live between a tool result and the next model call of the same turn", () => {
		expect(
			assistantTurnLive({
				streaming: true,
				pending: false,
				lastInGroup: 4,
				lastIndex: 5,
				lastNonResult: 4,
				stopReason: "toolUse",
			}),
		).toBe(true);
	});

	it("stays live while the last assistant message is still using a tool", () => {
		expect(
			assistantTurnLive({
				streaming: true,
				pending: false,
				lastInGroup: 4,
				lastIndex: 4,
				lastNonResult: 4,
				stopReason: "toolUse",
			}),
		).toBe(true);
	});

	it("leaves earlier turns folded while a later one is streaming", () => {
		expect(
			assistantTurnLive({
				streaming: true,
				pending: false,
				lastInGroup: 1,
				lastIndex: 5,
				lastNonResult: 5,
				stopReason: "stop",
			}),
		).toBe(false);
	});
});
