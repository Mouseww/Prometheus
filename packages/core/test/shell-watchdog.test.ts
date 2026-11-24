import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellWatchdog } from "../src/agent/pi/shell-watchdog.ts";

describe("ShellWatchdog", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reports a call with no change for the idle window", () => {
		const stuck = vi.fn();
		const w = new ShellWatchdog(stuck, 30_000, 600_000);
		w.start("1", "bash", { command: "tail -f x" });
		vi.advanceTimersByTime(570_000);
		expect(stuck).not.toHaveBeenCalled();
		vi.advanceTimersByTime(60_000);
		expect(stuck).toHaveBeenCalledTimes(1);
		expect(stuck).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "1", command: "tail -f x" }));
	});
	it("keeps waiting while output keeps changing", () => {
		const stuck = vi.fn();
		const w = new ShellWatchdog(stuck, 30_000, 600_000);
		w.start("1", "bash", { command: "npm i" });
		for (let i = 0; i < 40; i++) {
			vi.advanceTimersByTime(60_000);
			w.touch("1");
		}
		expect(stuck).not.toHaveBeenCalled();
	});
	it("stays quiet when the call ends or is not a shell tool", () => {
		const stuck = vi.fn();
		const w = new ShellWatchdog(stuck, 30_000, 600_000);
		w.start("1", "bash", { command: "ls" });
		w.end("1");
		w.start("2", "read", {});
		vi.advanceTimersByTime(3_600_000);
		expect(stuck).not.toHaveBeenCalled();
	});
});
