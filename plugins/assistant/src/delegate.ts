import type { AgentRunOptions, AgentRunResult, WorkspaceRef } from "@prometheus/plugin-sdk";
import type { RunAccess } from "@prometheus/protocol";
import { sameDir } from "./home.ts";

export interface DelegationCard {
	sessionId?: string;
	project: string;
	status: "success" | "error" | "aborted" | "refused";
	/** What the model asked for and what the host let the run do. */
	requested: RunAccess;
	access: RunAccess;
}

export interface DelegateDeps {
	homeDir: string;
	workspaces(): Promise<WorkspaceRef[]>;
	runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
	/** The project a session was delegated to, if this assistant delegated it. */
	delegatedProject(sessionId: string): string | undefined;
	/** A delegated session came into being (called while it is still running). */
	started(sessionId: string, project: string): void;
}

export interface DelegateParams {
	project: string;
	task: string;
	access?: string;
	/** Session id of an earlier delegation to carry on instead of starting a new one. */
	continue_session?: string;
}

export interface DelegateCall {
	cwd: string;
	sessionId: string | undefined;
	signal?: AbortSignal;
}

export interface DelegateOutcome {
	text: string;
	card: DelegationCard;
}

const projectsOf = (list: WorkspaceRef[], homeDir: string) => list.filter((w) => !sameDir(w.path, homeDir));

/** Exactly one project by id, exact name, or an unambiguous part of the name. */
export function pickProject(list: WorkspaceRef[], query: string): WorkspaceRef | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	const byId = list.find((w) => w.id === query.trim());
	if (byId) return byId;
	const exact = list.filter((w) => w.name.toLowerCase() === q);
	if (exact.length === 1) return exact[0];
	const part = list.filter((w) => w.name.toLowerCase().includes(q));
	return part.length === 1 ? part[0] : undefined;
}

const refused = (project: string, why: string, requested: RunAccess): DelegateOutcome => ({ text: why, card: { project, status: "refused", requested, access: "readonly" } });

export async function delegate(deps: DelegateDeps, call: DelegateCall, params: DelegateParams): Promise<DelegateOutcome> {
	const requested: RunAccess = params.access === "edits" ? "edits" : "readonly";
	if (!sameDir(call.cwd, deps.homeDir)) return refused(params.project, "assistant_delegate only works from the assistant's own home, not from inside a project.", requested);
	const task = String(params.task ?? "").trim().slice(0, 6000);
	if (!task) return refused(params.project, "Describe the task.", requested);
	const projects = projectsOf(await deps.workspaces(), deps.homeDir);
	const ws = pickProject(projects, String(params.project ?? ""));
	if (!ws) return refused(String(params.project ?? ""), `No single project matches "${params.project}". Projects:\n${projects.map((w) => `- ${w.name}`).join("\n") || "(none)"}`, requested);

	// One piece of work, one session: carrying on an earlier delegation goes back into that session. Only the model
	// can say the new task belongs to it, so it names the session; a different project or a stranger's id is refused.
	const again = String(params.continue_session ?? "").trim();
	if (again) {
		const was = deps.delegatedProject(again);
		if (was === undefined) return refused(ws.name, `continue_session "${again}" is not a session you delegated. Leave it out to start a new one.`, requested);
		if (was.toLowerCase() !== ws.name.toLowerCase()) return refused(ws.name, `Session "${again}" belongs to project "${was}", not "${ws.name}".`, requested);
	}

	let r;
	try {
		r = await deps.runAgent({
			cwd: ws.path,
			prompt: task,
			name: `助理派活：${task.replace(/\s+/g, " ").slice(0, 24)}`,
			access: requested,
			...(again ? { sessionId: again } : {}),
			onStart: (id) => deps.started(id, ws.name),
			// The host caps this at what the calling chat may do; an unknown caller can only read.
			...(call.sessionId ? { parentSessionId: call.sessionId } : {}),
			...(call.signal ? { signal: call.signal } : {}),
			timeoutMs: 20 * 60_000,
		});
	} catch (err) {
		if (!again) throw err;
		return refused(ws.name, `Session "${again}" could not be continued (it is probably still running). Wait for it to finish, or start a new one by leaving continue_session out.`, requested);
	}
	const note = r.access !== requested ? `Edits were not allowed here (this chat's permission mode), so the task ran read-only; tell the user if changes were needed and how to allow them.\n` : "";
	const body = String(r.text || r.error || "").slice(0, 8000);
	return {
		text: `${note}Project "${ws.name}" (${r.access}): ${r.status} (session ${r.sessionId}; pass it as continue_session to carry on the same work)\n${body}`,
		card: { sessionId: r.sessionId, project: ws.name, status: r.status, requested, access: r.access },
	};
}
