import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDefaultShellTimeout, defaultShellTimeoutSeconds, ShellWatchdog } from "../src/agent/pi/shell-watchdog.ts";

describe("applyDefaultShellTimeout", () => {
	it("adds a timeout to shell calls without one", () => {
		const input: Record<string, unknown> = { command: "sleep 1" };
		expect(applyDefaultShellTimeout("bash", input, 600)).toBe(true);
		expect(input.timeout).toBe(600);
	});
	it("keeps an explicit timeout and ignores other tools", () => {
		const input: Record<string, unknown> = { command: "x", timeout: 5 };
		expect(applyDefaultShellTimeout("bash", input, 600)).toBe(false);
		expect(input.timeout).toBe(5);
		expect(applyDefaultShellTimeout("read", {}, 600)).toBe(false);
	});
	it("can be disabled by env", () => {
		expect(defaultShellTimeoutSeconds({ PROMETHEUS_SHELL_TIMEOUT: "0" })).toBe(0);
		expect(applyDefaultShellTimeout("bash", {}, 0)).toBe(false);
	});
});

describe("ShellWatchdog", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reports a call still open after timeout + grace", () => {
		const stuck = vi.fn();
		const w = new ShellWatchdog(stuck, 1000, 900);
		w.start("1", "bash", { command: "tail -f x", timeout: 10 });
		vi.advanceTimersByTime(10_999);
		expect(stuck).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2);
		expect(stuck).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "1", command: "tail -f x" }));
	});
	it("stays quiet when the call ends", () => {
		const stuck = vi.fn();
		const w = new ShellWatchdog(stuck, 1000, 900);
		w.start("1", "bash", { command: "ls", timeout: 10 });
		w.end("1");
		vi.advanceTimersByTime(60_000);
		expect(stuck).not.toHaveBeenCalled();
	});
});
