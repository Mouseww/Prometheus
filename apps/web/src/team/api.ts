// The team UI talks to a Hub through this interface only. Two implementations exist:
//   createHubApi    (./hubApi.ts)    direct fetch to /plugins/team/api with the user's own tokens (Hub mode)
//   createMemberApi (./memberApi.ts) relays through the local team plugin (member mode)
import type {
	AdminOrgView,
	AdminUserView,
	DisposableDomainView,
	TransferView,
	VerifyEmailResult,
	AuditPage,
	AuditQuery,
	Board,
	BillingSettings,
	BillingSummary,
	ByokAllowed,
	ByokSettingsView,
	CheckoutInput,
	CheckoutResult,
	CreateUserGatewayInput,
	GenerateCodesInput,
	GeneratedCodes,
	GrantCreditsInput,
	OrderQuery,
	OrdersPage,
	OrderView,
	PlanInput,
	PlanView,
	PriceInput,
	PriceView,
	RedeemCodeView,
	RedeemResult,
	SetByokInput,
	UpdateUserGatewayInput,
	UserGatewayView,
	CreateGatewayInput,
	CreateOrgInput,
	CreateWorkspaceInput,
	CreatedInvitation,
	FileListing,
	ForkResult,
	GatewayFilter,
	GatewayView,
	InvitationInput,
	ListUsersQuery,
	MeResult,
	MergeRequestDiff,
	MergeRequestStatus,
	MergeRequestView,
	NotificationsPage,
	NotificationsQuery,
	OrgMemberView,
	OrgRole,
	OrgSummary,
	PlatformSettings,
	PublicUser,
	QuotaFilter,
	QuotaView,
	RegistrationPolicy,
	ReportView,
	SessionAction,
	SessionDetail,
	SessionEventsPage,
	SessionEventsQuery,
	SessionTranscript,
	SessionView,
	SetQuotaInput,
	TeamMemberView,
	TeamRole,
	TeamView,
	UpdateGatewayInput,
	UpdateWorkspaceInput,
	UsageQuery,
	UsageRow,
	VisibleModel,
	WorkspaceView,
	SessionStatus,
	ExecMode,
	ExecLocation,
	ExecState,
	MyRuntime,
	NodeInput,
	NodeView,
	RuntimeLimitsInput,
	RuntimesListing,
	RuntimeView,
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
	/** `expectedHeadCommit` is the head the reviewer saw; the Hub answers 409 `headChanged` when the branch moved since. */
	approveMergeRequest(id: string, expectedHeadCommit: string): Promise<MergeRequestView>;
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
	/** Only the given fields change. */
	putSettings(settings: Partial<PlatformSettings>): Promise<PlatformSettings>;

	createInvitation(input: InvitationInput): Promise<CreatedInvitation>;

	listOrgs(): Promise<OrgSummary[]>;
	createOrg(input: CreateOrgInput): Promise<OrgSummary>;
	listOrgMembers(orgId: string): Promise<OrgMemberView[]>;
	setOrgMember(orgId: string, userId: string, role: OrgRole): Promise<OrgMemberView>;
	removeOrgMember(orgId: string, userId: string): Promise<void>;

	listAudit(query?: AuditQuery): Promise<AuditPage>;

	// ---- online service: team transfer into an organization ----
	/** Personal team admin asks to move the team into an organization they belong to. */
	requestTeamTransfer(teamId: string, orgId: string): Promise<TransferView>;
	/** Requests the viewer made, plus requests for organizations they administer (operators see all). */
	listTransfers(): Promise<TransferView[]>;
	acceptTransfer(id: string): Promise<TransferView>;
	rejectTransfer(id: string): Promise<TransferView>;
	/** Only the requester may cancel. */
	cancelTransfer(id: string): Promise<TransferView>;

	// ---- online service: operator console ----
	listAdminOrgs(): Promise<AdminOrgView[]>;
	/** Disables the account, revokes its tokens and stops its tenant runtime. */
	banUser(userId: string): Promise<PublicUser>;
	listDisposableDomains(): Promise<DisposableDomainView[]>;
	addDisposableDomain(domain: string): Promise<DisposableDomainView>;
	removeDisposableDomain(domain: string): Promise<void>;

	// ---- sessions (mirror, spectate, grants, relay, fork) ----
	listSessions(workspaceId: string, filter?: { status?: SessionStatus; owner?: string; limit?: number }): Promise<SessionView[]>;
	getSession(sessionId: string): Promise<SessionDetail>;
	listSessionEvents(sessionId: string, query?: SessionEventsQuery): Promise<SessionEventsPage>;
	getSessionTranscript(sessionId: string): Promise<SessionTranscript>;
	/** Files of the session snapshot. `path` is a repository-relative directory or file; empty for the root. */
	browseSessionFiles(sessionId: string, path?: string): Promise<FileListing>;
	listSessionGrants(sessionId: string): Promise<string[]>;
	grantSession(sessionId: string, userId: string): Promise<unknown>;
	revokeSessionGrant(sessionId: string, userId: string): Promise<void>;
	/** Relay an action to the owner's machine. Fails with notGranted, ownerOffline, relayFailed or relayTimeout. */
	sendSessionAction(sessionId: string, action: SessionAction): Promise<unknown>;
	forkSession(sessionId: string, input?: { title?: string }): Promise<ForkResult>;
	// ---- hybrid execution (owner only) ----
	getSessionExec(sessionId: string): Promise<ExecState>;
	setSessionExecMode(sessionId: string, mode: ExecMode): Promise<ExecState>;
	/** Moves the session's brain to the other side. `force` interrupts a running agent (the Hub answers `agentBusy` otherwise). */
	handoffSession(sessionId: string, to: ExecLocation, force?: boolean): Promise<ExecState>;

	// ---- tenant runtimes and executor nodes ----
	/** The caller's own tenant runtime (status for the workbench entry). */
	getMyRuntime(): Promise<MyRuntime>;
	/** Warms the caller's tenant up; resolves with the status right after the start was requested. */
	startMyRuntime(): Promise<MyRuntime>;
	listRuntimes(): Promise<RuntimesListing>;
	stopRuntime(userId: string): Promise<RuntimeView>;
	setRuntimeLimits(userId: string, limits: RuntimeLimitsInput): Promise<RuntimeView>;
	listNodes(): Promise<NodeView[]>;
	createNode(input: NodeInput): Promise<NodeView>;
	updateNode(id: string, patch: Partial<NodeInput>): Promise<NodeView>;
	drainNode(id: string): Promise<NodeView>;
	pingNode(id: string): Promise<{ ok: boolean }>;
	deleteNode(id: string): Promise<void>;

	// ---- board, daily reports, notifications ----
	getBoard(workspaceId: string): Promise<Board>;
	/** The report for `date` (the latest one when omitted); null when none exists. */
	getReport(workspaceId: string, date?: string): Promise<ReportView | null>;
	generateReport(workspaceId: string, date?: string): Promise<ReportView>;
	listNotifications(query?: NotificationsQuery): Promise<NotificationsPage>;
	markNotificationsRead(input: { ids?: string[]; all?: boolean }): Promise<{ updated: number }>;

	// ---- model gateways, quotas, usage ----
	listGateways(filter?: GatewayFilter): Promise<GatewayView[]>;
	createGateway(input: CreateGatewayInput): Promise<GatewayView>;
	updateGateway(id: string, patch: UpdateGatewayInput): Promise<GatewayView>;
	deleteGateway(id: string): Promise<void>;
	listQuotas(filter?: QuotaFilter): Promise<QuotaView[]>;
	/** Upserts a limit; `limitTokens: null` removes it (the Hub then answers null). */
	setQuota(input: SetQuotaInput): Promise<QuotaView | null>;
	getUsage(query: UsageQuery): Promise<UsageRow[]>;
	listModels(): Promise<VisibleModel[]>;

	// ---- BYOK: personal gateways and the platform / organization switch ----
	listMyGateways(): Promise<UserGatewayView[]>;
	createMyGateway(input: CreateUserGatewayInput): Promise<UserGatewayView>;
	updateMyGateway(id: string, patch: UpdateUserGatewayInput): Promise<UserGatewayView>;
	deleteMyGateway(id: string): Promise<void>;
	/** Whether the viewer may use personal gateways at all. */
	getMyByok(): Promise<ByokAllowed>;
	getByokSettings(orgId?: string): Promise<ByokSettingsView>;
	setByokSettings(input: SetByokInput): Promise<unknown>;

	// ---- billing (user routes answer 404 billingDisabled when billing is off) ----
	listBillingPlans(): Promise<PlanView[]>;
	getBillingSummary(orgId?: string): Promise<BillingSummary>;
	checkout(input: CheckoutInput): Promise<CheckoutResult>;
	redeemCode(input: { code: string; orgId?: string }): Promise<RedeemResult>;

	// ---- billing, operator ----
	listAdminPlans(): Promise<PlanView[]>;
	createPlan(input: PlanInput): Promise<PlanView>;
	updatePlan(id: string, patch: Partial<PlanInput>): Promise<PlanView>;
	deletePlan(id: string): Promise<void>;
	listPrices(): Promise<PriceView[]>;
	createPrice(input: PriceInput): Promise<PriceView>;
	updatePrice(id: string, patch: Partial<PriceInput>): Promise<PriceView>;
	deletePrice(id: string): Promise<void>;
	listOrders(query?: OrderQuery): Promise<OrdersPage>;
	markOrderPaid(id: string): Promise<OrderView>;
	markOrderRefunded(id: string): Promise<OrderView>;
	listRedeemCodes(): Promise<RedeemCodeView[]>;
	/** The only reply that carries the plaintext codes. */
	generateRedeemCodes(input: GenerateCodesInput): Promise<GeneratedCodes>;
	getBillingSettings(): Promise<BillingSettings>;
	putBillingSettings(patch: Partial<BillingSettings>): Promise<BillingSettings>;
	grantCredits(input: GrantCreditsInput): Promise<{ id: string }>;

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
	/** Signed-in user redeems an invitation link for the current account. */
	acceptInvitation(token: string): Promise<import("./types.ts").AcceptedInvitation>;
	/** Redeems the token of the mailed link. The token works once. */
	verifyEmail(token: string): Promise<VerifyEmailResult>;
	/** Always succeeds (the Hub never reveals whether the account exists). */
	resendVerification(email: string): Promise<void>;
	forgotPassword(email: string): Promise<void>;
	resetPassword(token: string, password: string): Promise<void>;
	logout(): Promise<void>;
	/** Address that opens the caller's tenant runtime (`<hub>/rt/`) with a fresh access token for the proxy; undefined when signed out. */
	workbenchUrl(hubUrl?: string): Promise<string | undefined>;
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
		approveMergeRequest: (id, expectedHeadCommit) => send("POST", `/api/merge-requests/${seg(id)}/approve`, { expectedHeadCommit }),
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

		requestTeamTransfer: (teamId, orgId) => send("POST", `/api/teams/${seg(teamId)}/transfer`, { orgId }),
		listTransfers: () => get("/api/transfers"),
		acceptTransfer: (id) => send("POST", `/api/transfers/${seg(id)}/accept`),
		rejectTransfer: (id) => send("POST", `/api/transfers/${seg(id)}/reject`),
		cancelTransfer: (id) => send("POST", `/api/transfers/${seg(id)}/cancel`),

		listAdminOrgs: () => get("/api/admin/orgs"),
		banUser: (id) => send("POST", `/api/admin/users/${seg(id)}/ban`),
		listDisposableDomains: () => get("/api/admin/disposable-domains"),
		addDisposableDomain: (domain) => send("POST", "/api/admin/disposable-domains", { domain }),
		removeDisposableDomain: (domain) => empty("DELETE", `/api/admin/disposable-domains/${seg(domain)}`),

		listSessions: (workspaceId, filter) => get(`/api/workspaces/${seg(workspaceId)}/sessions`, { ...filter }),
		getSession: (id) => get(`/api/sessions/${seg(id)}`),
		listSessionEvents: (id, query) => get(`/api/sessions/${seg(id)}/events`, { ...query }),
		getSessionTranscript: (id) => get(`/api/sessions/${seg(id)}/transcript`),
		browseSessionFiles: (id, path) => get(`/api/sessions/${seg(id)}/files`, { path }),
		listSessionGrants: (id) => get(`/api/sessions/${seg(id)}/grants`),
		grantSession: (id, userId) => send("POST", `/api/sessions/${seg(id)}/grants`, { userId }),
		revokeSessionGrant: (id, userId) => empty("DELETE", `/api/sessions/${seg(id)}/grants/${seg(userId)}`),
		sendSessionAction: (id, action) => send("POST", `/api/sessions/${seg(id)}/actions`, action),
		forkSession: (id, input) => send("POST", `/api/sessions/${seg(id)}/fork`, input?.title ? { title: input.title } : {}),
		getSessionExec: (id) => get(`/api/sessions/${seg(id)}/exec`),
		setSessionExecMode: (id, mode) => send("PATCH", `/api/sessions/${seg(id)}/exec`, { mode }),
		handoffSession: (id, to, force) => send("POST", `/api/sessions/${seg(id)}/handoff`, force ? { to, force: true } : { to }),

		getMyRuntime: () => get("/api/runtime"),
		startMyRuntime: () => send("POST", "/api/runtime/start"),
		listRuntimes: () => get("/api/admin/runtimes"),
		stopRuntime: (userId) => send("POST", `/api/admin/runtimes/${seg(userId)}/stop`),
		setRuntimeLimits: (userId, limits) => send("PUT", `/api/admin/runtimes/${seg(userId)}/limits`, limits),
		listNodes: () => get("/api/admin/nodes"),
		createNode: (input) => send("POST", "/api/admin/nodes", input),
		updateNode: (id, patch) => send("PUT", `/api/admin/nodes/${seg(id)}`, patch),
		drainNode: (id) => send("POST", `/api/admin/nodes/${seg(id)}/drain`),
		pingNode: (id) => send("POST", `/api/admin/nodes/${seg(id)}/ping`),
		deleteNode: (id) => empty("DELETE", `/api/admin/nodes/${seg(id)}`),

		getBoard: (workspaceId) => get(`/api/workspaces/${seg(workspaceId)}/board`),
		getReport: (workspaceId, date) => get(`/api/workspaces/${seg(workspaceId)}/reports`, { date }),
		generateReport: (workspaceId, date) => send("POST", `/api/workspaces/${seg(workspaceId)}/reports/generate`, date ? { date } : {}),
		listNotifications: (query) => get("/api/notifications", { unread: query?.unread ? "1" : undefined, before: query?.before, limit: query?.limit }),
		markNotificationsRead: (input) => send("POST", "/api/notifications/read", input),

		listGateways: (filter) => get("/api/admin/gateways", { ...filter }),
		createGateway: (input) => send("POST", "/api/admin/gateways", input),
		updateGateway: (id, patch) => send("PUT", `/api/admin/gateways/${seg(id)}`, patch),
		deleteGateway: (id) => empty("DELETE", `/api/admin/gateways/${seg(id)}`),
		listQuotas: (filter) => get("/api/admin/quotas", { ...filter }),
		setQuota: (input) => send("PUT", "/api/admin/quotas", input),
		getUsage: (query) => get("/api/admin/usage", { ...query }),
		listModels: () => get("/api/models"),

		listMyGateways: () => get("/api/me/gateways"),
		createMyGateway: (input) => send("POST", "/api/me/gateways", input),
		updateMyGateway: (id, patch) => send("PUT", `/api/me/gateways/${seg(id)}`, patch),
		deleteMyGateway: (id) => empty("DELETE", `/api/me/gateways/${seg(id)}`),
		getMyByok: () => get("/api/me/byok"),
		getByokSettings: (orgId) => get("/api/admin/byok", { orgId }),
		setByokSettings: (input) => send("PUT", "/api/admin/byok", input),

		listBillingPlans: () => get("/api/billing/plans"),
		getBillingSummary: (orgId) => get("/api/billing/summary", { orgId }),
		checkout: (input) => send("POST", "/api/billing/checkout", input),
		redeemCode: (input) => send("POST", "/api/billing/redeem", input),

		listAdminPlans: () => get("/api/admin/plans"),
		createPlan: (input) => send("POST", "/api/admin/plans", input),
		updatePlan: (id, patch) => send("PUT", `/api/admin/plans/${seg(id)}`, patch),
		deletePlan: (id) => empty("DELETE", `/api/admin/plans/${seg(id)}`),
		listPrices: () => get("/api/admin/prices"),
		createPrice: (input) => send("POST", "/api/admin/prices", input),
		updatePrice: (id, patch) => send("PUT", `/api/admin/prices/${seg(id)}`, patch),
		deletePrice: (id) => empty("DELETE", `/api/admin/prices/${seg(id)}`),
		listOrders: (query) => get("/api/admin/orders", { ...query }),
		markOrderPaid: (id) => send("POST", `/api/admin/orders/${seg(id)}/mark-paid`),
		markOrderRefunded: (id) => send("POST", `/api/admin/orders/${seg(id)}/mark-refunded`),
		listRedeemCodes: () => get("/api/admin/redeem-codes"),
		generateRedeemCodes: (input) => send("POST", "/api/admin/redeem-codes", input),
		getBillingSettings: () => get("/api/admin/billing/settings"),
		putBillingSettings: (patch) => send("PUT", "/api/admin/billing/settings", patch),
		grantCredits: (input) => send("POST", "/api/admin/credits", input),
	};
}
