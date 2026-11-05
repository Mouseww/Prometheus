// The team UI talks to a Hub through this interface only. Two implementations exist:
//   createHubApi    (./hubApi.ts)    direct fetch to /plugins/team/api with the user's own tokens (Hub mode)
//   createMemberApi (./memberApi.ts) relays through the local team plugin (member mode)
import type {
	AdminUserView,
	AuditPage,
	AuditQuery,
	CreateOrgInput,
	CreateWorkspaceInput,
	CreatedInvitation,
	InvitationInput,
	ListUsersQuery,
	MeResult,
	MergeRequestDiff,
	MergeRequestStatus,
	MergeRequestView,
	OrgMemberView,
	OrgRole,
	OrgSummary,
	PlatformSettings,
	PublicUser,
	RegistrationPolicy,
	TeamMemberView,
	TeamRole,
	TeamView,
	UpdateWorkspaceInput,
	WorkspaceView,
} from "./types.ts";

/** The Hub is mounted under this prefix; every request path below is Hub-relative and starts with `/api/`. */
export const HUB_API_BASE = "/plugins/team";
export const HUB_WS_PATH = "/plugins/team/ws";

/** Failure of a Hub call. `code` is the Hub's error code ("forbidden", "mergeConflict", ...) or a transport code. */
export class TeamApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "TeamApiError";
		this.status = status;
		this.code = code;
	}
}

export type TeamEvent = unknown;
export type Unsubscribe = () => void;

export interface TeamApi {
	me(): Promise<MeResult>;

	listTeams(): Promise<TeamView[]>;
	createTeam(input: { name: string; orgId?: string | null }): Promise<TeamView>;
	listTeamMembers(teamId: string): Promise<TeamMemberView[]>;
	addTeamMember(teamId: string, input: { userId?: string; email?: string; role: TeamRole }): Promise<TeamMemberView>;
	setTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<TeamMemberView>;
	removeTeamMember(teamId: string, userId: string): Promise<void>;

	listWorkspaces(teamId: string): Promise<WorkspaceView[]>;
	createWorkspace(teamId: string, input: CreateWorkspaceInput): Promise<WorkspaceView>;
	getWorkspace(workspaceId: string): Promise<WorkspaceView>;
	updateWorkspace(workspaceId: string, patch: UpdateWorkspaceInput): Promise<WorkspaceView>;

	listMergeRequests(workspaceId: string, filter?: { status?: MergeRequestStatus }): Promise<MergeRequestView[]>;
	getMergeRequest(id: string): Promise<MergeRequestView>;
	getMergeRequestDiff(id: string): Promise<MergeRequestDiff>;
	approveMergeRequest(id: string): Promise<MergeRequestView>;
	rejectMergeRequest(id: string, reason?: string): Promise<MergeRequestView>;
	refreshMergeRequest(id: string): Promise<MergeRequestView>;
	closeMergeRequest(id: string): Promise<MergeRequestView>;

	listUsers(query?: ListUsersQuery): Promise<AdminUserView[]>;
	createUser(input: { email: string; displayName: string; password: string; orgId?: string }): Promise<PublicUser>;
	approveUser(userId: string): Promise<PublicUser>;
	disableUser(userId: string): Promise<PublicUser>;
	enableUser(userId: string): Promise<PublicUser>;

	getPlatformRegistration(): Promise<RegistrationPolicy>;
	putPlatformRegistration(policy: RegistrationPolicy): Promise<RegistrationPolicy>;
	getOrgRegistration(orgId: string): Promise<RegistrationPolicy>;
	putOrgRegistration(orgId: string, policy: RegistrationPolicy): Promise<RegistrationPolicy>;
	getSettings(): Promise<PlatformSettings>;
	putSettings(settings: PlatformSettings): Promise<PlatformSettings>;

	createInvitation(input: InvitationInput): Promise<CreatedInvitation>;

	listOrgs(): Promise<OrgSummary[]>;
	createOrg(input: CreateOrgInput): Promise<OrgSummary>;
	listOrgMembers(orgId: string): Promise<OrgMemberView[]>;
	setOrgMember(orgId: string, userId: string, role: OrgRole): Promise<OrgMemberView>;
	removeOrgMember(orgId: string, userId: string): Promise<void>;

	listAudit(query?: AuditQuery): Promise<AuditPage>;

	/**
	 * Receive realtime events for a topic ("user", "workspace:<id>", "session:<id>"). Returns the unsubscribe function.
	 * Hub mode uses the Hub WebSocket, member mode the plugin watch on `hub:<topic>`.
	 */
	subscribe(topic: string, cb: (event: TeamEvent) => void): Unsubscribe;
}

/** Hub mode adds the account endpoints that member mode never needs (the plugin owns the credentials there). */
export interface HubApi extends TeamApi {
	/** Public. */
	meta(): Promise<import("./types.ts").MetaInfo>;
	login(email: string, password: string, remember: boolean): Promise<PublicUser>;
	register(input: import("./types.ts").RegisterInput): Promise<import("./types.ts").RegisterResult>;
	/** Public lookup of an invitation link token. */
	lookupInvitation(token: string): Promise<import("./types.ts").InvitationView>;
	logout(): Promise<void>;
	/** True when an access or refresh token is stored (it may still be expired). */
	hasSession(): boolean;
	/** Called once when the session ends for good (refresh failed or logout). */
	onSessionEnd(cb: () => void): Unsubscribe;
}

/** Transport shared by both implementations: one request in, the envelope's data out. */
export interface Requester {
	request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

/** Path plus a query string made of the defined entries only. */
export function withQuery(path: string, query?: Query): string {
	if (!query) return path;
	const parts: string[] = [];
	for (const [k, v] of Object.entries(query)) {
		if (v === undefined || v === null || v === "") continue;
		parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
	}
	return parts.length ? `${path}?${parts.join("&")}` : path;
}

const seg = encodeURIComponent;

const isEnvelope = (v: unknown): v is { ok: boolean } => typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean";

/** Unwraps `{ok:true,data}` and throws TeamApiError for `{ok:false,error}`. Anything else is passed through as data. */
export function unwrapEnvelope<T>(value: unknown, status = 200): T {
	if (isEnvelope(value)) {
		const env = value as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
		if (env.ok) return env.data as T;
		throw new TeamApiError(status >= 400 ? status : 400, env.error?.code ?? "error", env.error?.message ?? "Request failed");
	}
	return value as T;
}

/** All endpoint wrappers, written once over a Requester so both modes build identical requests. */
export function createApiMethods(r: Requester): Omit<TeamApi, "subscribe"> {
	const get = <T>(path: string, query?: Query) => r.request<T>("GET", withQuery(path, query));
	const send = <T>(method: string, path: string, body?: unknown) => r.request<T>(method, path, body);
	const empty = async (method: string, path: string): Promise<void> => {
		await r.request<unknown>(method, path);
	};
	return {
		me: () => get("/api/me"),

		listTeams: () => get("/api/teams"),
		createTeam: (input) => send("POST", "/api/teams", input),
		listTeamMembers: (teamId) => get(`/api/teams/${seg(teamId)}/members`),
		addTeamMember: (teamId, input) => send("POST", `/api/teams/${seg(teamId)}/members`, input),
		setTeamMemberRole: (teamId, userId, role) => send("PUT", `/api/teams/${seg(teamId)}/members/${seg(userId)}`, { role }),
		removeTeamMember: (teamId, userId) => empty("DELETE", `/api/teams/${seg(teamId)}/members/${seg(userId)}`),

		listWorkspaces: (teamId) => get(`/api/teams/${seg(teamId)}/workspaces`),
		createWorkspace: (teamId, input) => send("POST", `/api/teams/${seg(teamId)}/workspaces`, input),
		getWorkspace: (id) => get(`/api/workspaces/${seg(id)}`),
		updateWorkspace: (id, patch) => send("PATCH", `/api/workspaces/${seg(id)}`, patch),

		listMergeRequests: (workspaceId, filter) => get(`/api/workspaces/${seg(workspaceId)}/merge-requests`, { status: filter?.status }),
		getMergeRequest: (id) => get(`/api/merge-requests/${seg(id)}`),
		getMergeRequestDiff: (id) => get(`/api/merge-requests/${seg(id)}/diff`),
		approveMergeRequest: (id) => send("POST", `/api/merge-requests/${seg(id)}/approve`),
		rejectMergeRequest: (id, reason) => send("POST", `/api/merge-requests/${seg(id)}/reject`, reason ? { reason } : {}),
		refreshMergeRequest: (id) => send("POST", `/api/merge-requests/${seg(id)}/refresh`),
		closeMergeRequest: (id) => send("POST", `/api/merge-requests/${seg(id)}/close`),

		listUsers: (query) => get("/api/admin/users", { ...query }),
		createUser: (input) => send("POST", "/api/admin/users", input),
		approveUser: (id) => send("POST", `/api/admin/users/${seg(id)}/approve`),
		disableUser: (id) => send("POST", `/api/admin/users/${seg(id)}/disable`),
		enableUser: (id) => send("POST", `/api/admin/users/${seg(id)}/enable`),

		getPlatformRegistration: () => get("/api/admin/registration"),
		putPlatformRegistration: (policy) => send("PUT", "/api/admin/registration", policy),
		getOrgRegistration: (orgId) => get(`/api/orgs/${seg(orgId)}/registration`),
		putOrgRegistration: (orgId, policy) => send("PUT", `/api/orgs/${seg(orgId)}/registration`, policy),
		getSettings: () => get("/api/admin/settings"),
		putSettings: (settings) => send("PUT", "/api/admin/settings", settings),

		createInvitation: (input) => send("POST", "/api/invitations", input),

		listOrgs: () => get("/api/orgs"),
		createOrg: (input) => send("POST", "/api/orgs", input),
		listOrgMembers: (orgId) => get(`/api/orgs/${seg(orgId)}/members`),
		setOrgMember: (orgId, userId, role) => send("PUT", `/api/orgs/${seg(orgId)}/members/${seg(userId)}`, { role }),
		removeOrgMember: (orgId, userId) => empty("DELETE", `/api/orgs/${seg(orgId)}/members/${seg(userId)}`),

		listAudit: (query) => get("/api/admin/audit", { ...query }),
	};
}
