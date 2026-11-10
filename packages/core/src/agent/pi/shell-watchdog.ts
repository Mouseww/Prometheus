/**
 * Guards against a shell tool call (bash / powershell) that never returns and freezes the whole conversation.
 *
 * Two layers:
 *  1. `applyDefaultShellTimeout` gives every call without an explicit `timeout` a ceiling, so PI's own
 *     timeout path kills the process tree (the SDK has no default timeout).
 *  2. `ShellWatchdog` is the probe: it tracks calls from `tool_execution_start` to `tool_execution_end`
 *     and, if one is still open after its timeout plus a grace period (the SDK's kill did not release
 *     it), calls `onStuck` so the host can abort the turn instead of waiting forever.
 */

export const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** Seconds. Override with PROMETHEUS_SHELL_TIMEOUT (0 disables the default). */
export function defaultShellTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PROMETHEUS_SHELL_TIMEOUT;
	if (raw === undefined || raw === "") return 900;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 900;
}

/** Mutates a tool input in place: adds the default timeout when the model gave none. Returns true if it did. */
export function applyDefaultShellTimeout(toolName: string, input: Record<string, unknown>, seconds = defaultShellTimeoutSeconds()): boolean {
	if (!SHELL_TOOLS.has(toolName) || seconds <= 0) return false;
	const t = input.timeout;
	if (typeof t === "number" && Number.isFinite(t) && t > 0) return false;
	input.timeout = seconds;
	return true;
}

export interface StuckCall {
	toolCallId: string;
	toolName: string;
	command: string;
	elapsedMs: number;
}

export class ShellWatchdog {
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	private readonly onStuck: (call: StuckCall) => void;
	private readonly graceMs: number;
	private readonly defaultSeconds: number;

	constructor(onStuck: (call: StuckCall) => void, graceMs = 30_000, defaultSeconds = defaultShellTimeoutSeconds()) {
		this.onStuck = onStuck;
		this.graceMs = graceMs;
		this.defaultSeconds = defaultSeconds;
	}

	start(toolCallId: string, toolName: string, args: unknown): void {
		if (!SHELL_TOOLS.has(toolName)) return;
		const a = (args ?? {}) as { command?: unknown; timeout?: unknown };
		const seconds = typeof a.timeout === "number" && a.timeout > 0 ? a.timeout : this.defaultSeconds;
		if (!(seconds > 0)) return;
		const began = Date.now();
		const timer = setTimeout(() => {
			this.timers.delete(toolCallId);
			this.onStuck({ toolCallId, toolName, command: String(a.command ?? "").slice(0, 200), elapsedMs: Date.now() - began });
		}, Math.min(seconds * 1000 + this.graceMs, 2_147_483_647));
		timer.unref?.();
		this.timers.set(toolCallId, timer);
	}

	end(toolCallId: string): void {
		const timer = this.timers.get(toolCallId);
		if (timer) clearTimeout(timer);
		this.timers.delete(toolCallId);
	}

	dispose(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
	}
}
