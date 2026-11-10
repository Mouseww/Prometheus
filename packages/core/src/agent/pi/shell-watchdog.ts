/**
 * Probe for shell tool calls (bash / powershell) that hang and freeze the conversation.
 *
 * Every `checkMs` it looks at each running call. A call counts as alive while it keeps producing output
 * (`tool_execution_update`), e.g. a download or install that prints progress. If nothing at all changed
 * for `idleMs`, `onStuck` is called so the host can abort the turn.
 */

export const SHELL_TOOLS = new Set(["bash", "powershell"]);

export interface StuckCall {
	toolCallId: string;
	toolName: string;
	command: string;
	idleMs: number;
}

interface Running {
	toolName: string;
	command: string;
	lastChange: number;
}

export class ShellWatchdog {
	private readonly onStuck: (call: StuckCall) => void;
	private readonly checkMs: number;
	private readonly idleMs: number;
	private readonly running = new Map<string, Running>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(onStuck: (call: StuckCall) => void, checkMs = 30_000, idleMs = 600_000) {
		this.onStuck = onStuck;
		this.checkMs = checkMs;
		this.idleMs = idleMs;
	}

	start(toolCallId: string, toolName: string, args: unknown): void {
		if (!SHELL_TOOLS.has(toolName)) return;
		const command = String((args as { command?: unknown } | undefined)?.command ?? "").slice(0, 200);
		this.running.set(toolCallId, { toolName, command, lastChange: Date.now() });
		if (!this.timer) {
			this.timer = setInterval(() => this.check(), this.checkMs);
			this.timer.unref?.();
		}
	}

	/** Output arrived: the call is making progress. */
	touch(toolCallId: string): void {
		const r = this.running.get(toolCallId);
		if (r) r.lastChange = Date.now();
	}

	end(toolCallId: string): void {
		this.running.delete(toolCallId);
		if (!this.running.size) this.stop();
	}

	dispose(): void {
		this.running.clear();
		this.stop();
	}

	private stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private check(): void {
		const now = Date.now();
		for (const [toolCallId, r] of [...this.running]) {
			if (now - r.lastChange < this.idleMs) continue;
			this.running.delete(toolCallId);
			this.onStuck({ toolCallId, toolName: r.toolName, command: r.command, idleMs: now - r.lastChange });
		}
		if (!this.running.size) this.stop();
	}
}
