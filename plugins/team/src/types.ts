/** A local session that belongs to a team workspace: only these are mirrored to the Hub. */
export interface SessionMapping {
	hubSessionId: string;
	workspaceId: string;
	teamId: string;
	worktree: string;
	branch: string;
	/** Next event sequence number to use; persisted after every successful upload so numbering survives restarts. */
	nextSeq?: number;
}

export interface WorkspaceMapping {
	/** The clone that serves as the source of worktrees (`<teamRoot>/<team>/<workspace>/.repo`). */
	repoDir: string;
	teamName: string;
	workspaceName: string;
	teamId?: string;
	defaultBranch?: string;
}

export interface LocalHubState {
	pid: number;
	host: string;
	port: number;
	/** PROMETHEUS_TOKEN of the child process; the owner needs it to open the Hub's own web page. */
	token: string;
	startedAt: string;
}

/** Contents of `<dataDir>/team/team.json` (0600). */
export interface TeamState {
	hubUrl?: string;
	userId?: string;
	displayName?: string;
	email?: string;
	refreshToken?: string;
	/** Stable id of this machine's server, sent to the Hub when a session is registered. */
	serverId: string;
	sessions: Record<string, SessionMapping>;
	workspaces: Record<string, WorkspaceMapping>;
	localHub?: LocalHubState;
}

export interface Envelope<T = unknown> {
	ok: boolean;
	data?: T;
	error?: { code: string; message: string };
}

export class TeamError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "TeamError";
		this.code = code;
		this.status = status;
	}
}

export const LOG = "[prometheus-team]";

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
