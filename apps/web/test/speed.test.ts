import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@prometheus/protocol";
import { estimateTokens, SpeedTracker } from "../src/lib/speed.ts";

const start = { type: "message_start", message: { role: "assistant", content: [] } } as unknown as SessionEvent;
const delta = (d: string) => ({ type: "message_update", delta: { type: "text_delta", contentIndex: 0, delta: d } }) as SessionEvent;
const end = (output: number) => ({ type: "message_end", message: { role: "assistant", content: [], provider: "gw", model: "m", usage: { output } } }) as unknown as SessionEvent;

describe("speed tracker", () => {
	it("times a reply from its first token and averages by weight", () => {
		const t = new SpeedTracker();
		t.feed("s", start, 0);
		t.feed("s", delta("hi"), 500);
		t.feed("s", end(100), 2500); // 100 tokens over 2 s
		expect(t.summary("s").last).toMatchObject({ tps: 50, ttftMs: 500, outputTokens: 100, model: "gw/m" });
		t.feed("s", start, 3000);
		t.feed("s", delta("x"), 3000);
		t.feed("s", end(300), 6000); // 300 over 3 s
		expect(t.summary("s")).toMatchObject({ avgTps: 80, replies: 2 });
		expect(t.summary("other").last).toBeNull();
	});
	it("ignores replies that did not stream, were too quick or reported no tokens", () => {
		const t = new SpeedTracker();
		t.feed("s", start, 0);
		t.feed("s", end(50), 1000);
		t.feed("s", start, 2000);
		t.feed("s", delta("a"), 2000);
		t.feed("s", end(5), 2100);
		t.feed("s", start, 3000);
		t.feed("s", delta("a"), 3000);
		t.feed("s", end(0), 5000);
		expect(t.summary("s").replies).toBe(0);
	});
	it("estimates a live rate from what arrived", () => {
		const t = new SpeedTracker();
		t.feed("s", start, 0);
		expect(t.live("s", 100)).toEqual({ tps: null, ttftMs: null });
		t.feed("s", delta("你".repeat(40)), 1000);
		t.feed("s", delta("a".repeat(40)), 2000);
		const l = t.live("s", 3000);
		expect(l?.ttftMs).toBe(1000);
		expect(l?.tps).toBeCloseTo(25, 5); // (40 + 10) tokens over 2 s
		t.feed("s", { type: "agent_settled", aborted: true }, 3000);
		expect(t.live("s", 3500)).toBeNull();
	});
	it("estimates CJK and Latin text", () => {
		expect(estimateTokens("你好")).toBe(2);
		expect(estimateTokens("abcdefgh")).toBe(2);
	});
});
