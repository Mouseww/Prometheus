import type { SubagentStep } from "@prometheus/protocol";
import type { AgentDef } from "./agents.ts";

/** One unit of delegated work, after the agent definition and the call's overrides are merged. */
export interface RunJob {
	def: AgentDef;
	task: string;
	cwd: string;
	/** Empty: the runner's own default (the parent's model for PI, the CLI's login for the others). */
	model?: string;
	thinking?: string;
}

/** What a runner reports while it works; the runtime turns it into the panel's state. */
export interface RunHooks {
	step(step: SubagentStep): void;
	tool(name: string): void;
	tokens(total: number): void;
	/** A step already reported has changed (a tool result arrived). */
	touch(): void;
	/** The model that was actually used. */
	model(name: string): void;
}

export type Runner = (job: RunJob, hooks: RunHooks, signal: AbortSignal) => Promise<string>;
