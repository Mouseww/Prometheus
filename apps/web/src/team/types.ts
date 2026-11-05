// DTOs of the Hub HTTP API (packages/hub). Mirrors the JSON the services return; dates are ISO strings.

export type UserStatus = "pending" | "active" | "disabled";
export type OrgRole = "owner" | "admin" | "member";
export type TeamRole = "admin" | "reviewer" | "member";

export interface PublicUser {
	id: string;
	email: string;
	displayName: string;
	status: UserStatus;
	platformRole: "operator" | null;
	emailVerifiedAt: string | null;
	createdAt: string;
}

export interface MetaInfo {
	version: string;
	publicKey: string;
	needsSetup: boolean;
	registration: { open: boolean; domains: string[]; approval: boolean; invite: boolean };
	/** Block 4A. Absent on a Hub that predates it, so every reader goes through ./logic/publicMode.ts. */
	mode?: "private" | "public";
	mailConfigured?: boolean;
	turnstileSiteKey?: string | null;
	turnstileRequired?: boolean;
	allowSelfCreateOrg?: boolean;
	/** Not sent by the Hub yet; honoured when it appears (see billingFromMeta). */
	billingEnabled?: boolean;
}

export interface RegisterInput {
	email: string;
	password: string;
	displayName: string;
	setupCode?: string;
	inviteToken?: string;
	turnstileToken?: string;
}

export interface VerifyEmailResult {
	verified: true;
	status: "active" | "pending";
}

export type TransferStatus = "pending" | "accepted" | "rejected" | "canceled";

export interface TransferView {
	id: string;
	teamId: string;
	teamName: string;
	fromUserId: string;
	toOrgId: string;
	toOrgName: string;
	status: TransferStatus;
	decidedBy: string | null;
	createdAt: string;
	decidedAt: string | null;
	/** Set on accept: users who were not organization members and were added as `member`. */
	addedMembers?: string[];
}

export interface AdminOrgView {
	id: string;
	name: string;
	slug: string;
	status: "active" | "disabled";
	memberCount: number;
	teamCount: number;
	createdAt: string;
}

export interface DisposableDomainView {
	domain: string;
	createdAt: string;
}

export interface RegisterResult {
	user: PublicUser;
	status: "active" | "pending";
	bootstrap: boolean;
}

export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	user: PublicUser;
}

export interface MeOrg {
	id: string;
	name: string;
	role: OrgRole;
}

export interface MeTeam {
	id: string;
	name: string;
	role: TeamRole;
	orgId: string | null;
}

export interface MeResult {
	user: PublicUser;
	orgs: MeOrg[];
	teams: MeTeam[];
}

export interface TeamView {
	id: string;
	name: string;
	orgId: string | null;
	ownerUserId: string | null;
	/** The viewer's effective role (implicit admin for operators and org owners/admins). */
	role: TeamRole;
	createdAt: string;
}

export interface TeamMemberView {
	userId: string;
	email: string;
	displayName: string;
	role: TeamRole;
}

export type UpstreamStatus = "ok" | "push_failed" | "fetch_failed" | "upstream_diverged";

export interface WorkspaceView {
	id: string;
	teamId: string;
	orgId: string | null;
	name: string;
	defaultBranch: string;
	dailyReportTime: string;
	dailyReportTz: string;
	dailyReportEnabled: boolean;
	upstreamUrl: string | null;
	upstreamStatus: UpstreamStatus | null;
	upstreamError: string | null;
	upstreamCheckedAt: string | null;
	hasUpstreamToken: boolean;
	createdAt: string;
}

export interface CreateWorkspaceInput {
	name: string;
	importUrl?: string;
	upstreamUrl?: string;
	upstreamToken?: string;
}

export interface UpdateWorkspaceInput {
	name?: string;
	dailyReportTime?: string;
	dailyReportTz?: string;
	dailyReportEnabled?: boolean;
	/** null removes the upstream. */
	upstreamUrl?: string | null;
	/** null removes the stored token. */
	upstreamToken?: string | null;
}

export type MergeRequestStatus = "open" | "approved" | "merged" | "rejected" | "conflict" | "closed";

export const MERGE_REQUEST_STATUSES: readonly MergeRequestStatus[] = ["open", "approved", "merged", "rejected", "conflict", "closed"];

export interface ConflictFile {
	path: string;
	binary: boolean;
	lastModifiedBy: { mergeRequestId: string | null; userId: string | null; displayName: string; commit: string } | null;
}

export interface MergeRequestView {
	id: string;
	workspaceId: string;
	sessionId: string | null;
	authorId: string;
	authorName: string;
	title: string;
	description: string;
	branch: string;
	baseCommit: string;
	headCommit: string;
	status: MergeRequestStatus;
	reviewerId: string | null;
	skippedReview: boolean;
	conflictFiles: ConflictFile[] | null;
	mergedCommit: string | null;
	decidedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface FileChange {
	path: string;
	status: string;
	additions: number | null;
	deletions: number | null;
	binary: boolean;
}

export interface MergeRequestDiff {
	mergeRequestId: string;
	base: string;
	head: string;
	diff: string;
	truncated: boolean;
	files: FileChange[];
}

export interface AdminUserView extends PublicUser {
	memberships: { orgId: string; role: OrgRole; status: "active" | "pending" }[];
}

export interface ListUsersQuery {
	status?: UserStatus;
	q?: string;
	limit?: number;
	offset?: number;
}

export interface RegistrationPolicy {
	allowOpen: boolean;
	allowedDomains: string[];
	requireApproval: boolean;
	allowInvite: boolean;
	closed: boolean;
}

export interface PlatformSettings {
	allowPersonalTeams: boolean;
	/** Public mode only: whether any verified user may create an organization. */
	allowSelfCreateOrg: boolean;
}

export type InvitationScope = "org" | "team";

export interface InvitationInput {
	scope: InvitationScope;
	scopeId: string;
	email: string;
	role: string;
}

export interface InvitationView {
	id: string;
	scope: InvitationScope;
	scopeId: string;
	scopeName: string;
	email: string;
	role: string;
	expiresAt: string;
}

/** What `POST /api/invitations/:token/accept` returns: the organization or team that was joined. */
export interface AcceptedInvitation {
	scope: InvitationScope;
	scopeId: string;
	scopeName: string;
	role: string;
	orgId: string | null;
}

export interface CreatedInvitation {
	link: string;
	token: string;
	invitation: InvitationView;
}

export interface OrgSummary {
	id: string;
	name: string;
	slug: string;
	status: "active" | "disabled";
	role: OrgRole | null;
	createdAt: string;
}

export interface OrgMemberView {
	userId: string;
	email: string;
	displayName: string;
	role: OrgRole;
	status: "active" | "pending";
}

export interface CreateOrgInput {
	name: string;
	slug?: string;
	ownerUserId?: string;
}

export interface AuditRecord {
	id: string;
	actorId: string | null;
	orgId: string | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	detail: Record<string, unknown>;
	createdAt: string;
}

export interface AuditQuery {
	orgId?: string;
	actor?: string;
	action?: string;
	before?: string;
	limit?: number;
}

export interface AuditPage {
	items: AuditRecord[];
	nextBefore: string | null;
}

// ---- Block 2C: session mirror, board, reports, notifications, models (packages/hub services) ----

export type SessionStatus = "running" | "waiting" | "idle" | "offline";

export interface SessionView {
	id: string;
	workspaceId: string;
	orgId: string | null;
	ownerUserId: string;
	ownerName: string | null;
	title: string;
	status: SessionStatus;
	branch: string;
	baseCommit: string;
	forkedFromSessionId: string | null;
	execLocation: string;
	lastActivityAt: string;
	snapshotCommit: string | null;
	/** Only the owner sees the mapping to their machine. */
	localSessionId: string | null;
	serverId: string | null;
	createdAt: string;
}

export interface SessionDetail extends SessionView {
	isOwner: boolean;
	/** The caller may send actions through the relay (owner or granted). */
	canAct: boolean;
	/** User ids holding a grant; only filled for the owner. */
	grants: string[];
	/** Hybrid execution preference (block 3). Absent on an older Hub. */
	execMode?: ExecMode;
	tenantSessionId?: string | null;
}

export interface SessionEvent {
	seq: number;
	kind: string;
	payload: unknown;
	createdAt: string;
}

export interface SessionEventsPage {
	items: SessionEvent[];
	nextAfter: number;
	hasMore: boolean;
}

export interface SessionEventsQuery {
	after?: number;
	limit?: number;
}

export interface SessionTranscript {
	format: string;
	/** gzip + base64 of the transcript text. */
	content: string;
	updatedAt: string;
}

export type SessionAction =
	| { type: "prompt"; text: string }
	| { type: "respond"; requestId: string; response: unknown }
	| { type: "abort" };

export interface ForkResult {
	session: SessionView;
	transcript: { format: string; content: string } | null;
	snapshotCommit: string | null;
	branch: string;
	sourceBranch: string;
}

export interface FileListEntry {
	name: string;
	type: "file" | "dir" | "submodule";
	size: number | null;
}

/** Shape of the Hub's file browser (workspace and session files). */
export type FileListing =
	| { type: "dir"; ref: string; commit: string; path: string; entries: FileListEntry[] }
	| { type: "file"; ref: string; commit: string; path: string; size: number; binary: boolean; encoding: "base64"; content: string };

export interface BoardSession {
	id: string;
	title: string;
	status: SessionStatus;
	lastActivityAt: string;
}

export interface BoardMember {
	user: { id: string; displayName: string; email: string };
	role: TeamRole;
	online: boolean;
	sessions: BoardSession[];
	lastActivityAt: string | null;
}

export interface BoardMergeRequest {
	id: string;
	title: string;
	authorId: string;
	authorName: string | null;
	branch: string;
	status: string;
	sessionId: string | null;
	createdAt: string;
	decidedAt: string | null;
}

export interface Board {
	members: BoardMember[];
	openMergeRequests: BoardMergeRequest[];
	recentMerges: BoardMergeRequest[];
}

export interface ReportContent {
	date: string;
	overall: string[];
	risks: string[];
	members: { userId: string; name: string; items: string[] }[];
}

export interface ReportView {
	id: string;
	workspaceId: string;
	date: string;
	content: ReportContent;
	generatedBy: "model" | "digest";
	createdAt: string;
}

export interface NotificationView {
	id: string;
	kind: string;
	payload: Record<string, unknown>;
	readAt: string | null;
	createdAt: string;
}

export interface NotificationsQuery {
	unread?: boolean;
	before?: string;
	limit?: number;
}

export interface NotificationsPage {
	items: NotificationView[];
	unread: number;
	nextBefore: string | null;
}

export type GatewayScope = "platform" | "org";
export type GatewayFormat = "openai" | "anthropic" | "gemini";
export const GATEWAY_FORMATS: readonly GatewayFormat[] = ["openai", "anthropic", "gemini"];

export interface GatewayModel {
	id: string;
	name?: string;
}

export interface GatewayView {
	id: string;
	scope: GatewayScope;
	scopeId: string;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	/** Never the key itself: the last four characters only. */
	apiKeyMasked: string;
	models: GatewayModel[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface GatewayFilter {
	scope?: GatewayScope;
	orgId?: string;
}

export interface CreateGatewayInput {
	scope: GatewayScope;
	scopeId?: string;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	apiKey: string;
	models?: (GatewayModel | string)[];
	enabled?: boolean;
}

export interface UpdateGatewayInput {
	name?: string;
	format?: GatewayFormat;
	baseUrl?: string;
	/** Omit to keep the stored key. */
	apiKey?: string;
	models?: (GatewayModel | string)[];
	enabled?: boolean;
}

export type QuotaSubject = "user" | "org";
export type QuotaPeriod = "day" | "month";

export interface QuotaView {
	id: string;
	subjectType: QuotaSubject;
	subjectId: string;
	period: QuotaPeriod;
	limitTokens: number;
	orgId: string | null;
}

export interface QuotaFilter {
	subjectType?: QuotaSubject;
	subjectId?: string;
}

export interface SetQuotaInput {
	subjectType: QuotaSubject;
	subjectId: string;
	period: QuotaPeriod;
	/** null removes the limit. */
	limitTokens: number | null;
}

export type UsageGroup = "user" | "org" | "day" | "model";

export interface UsageRow {
	key: string;
	label: string | null;
	inputTokens: number;
	outputTokens: number;
	requests: number;
}

export interface UsageQuery {
	groupBy: UsageGroup;
	from?: string;
	to?: string;
}

export interface VisibleModel {
	id: string;
	name: string;
	format: GatewayFormat;
	gatewayId: string;
	gatewayName: string;
	source: "user" | "org" | "platform";
}

// ---- billing and BYOK (packages/hub/src/billing, src/services/byok.ts) ----

/** A personal gateway (bring your own key). Same shape the admin gateways use, minus the scope. */
export interface UserGatewayView {
	id: string;
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	/** Never the key itself: the last four characters only. */
	apiKeyMasked: string;
	models: GatewayModel[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface CreateUserGatewayInput {
	name: string;
	format: GatewayFormat;
	baseUrl: string;
	apiKey: string;
	models?: GatewayModel[];
	enabled?: boolean;
}

export type UpdateUserGatewayInput = Partial<CreateUserGatewayInput>;

export interface ByokAllowed {
	allowed: boolean;
}

export type ByokScope = "platform" | "org";

export interface ByokSettingsView {
	/** Effective switch of the platform setting alone. */
	platform: boolean;
	/** The organization override; null when it follows the platform. */
	org: boolean | null;
}

export interface SetByokInput {
	scope: ByokScope;
	orgId?: string;
	/** null removes an organization override (follow the platform). */
	allowed: boolean | null;
}

export type BillingSubjectType = "user" | "org";
export type OrderKind = "topup" | "subscription";
export type OrderStatus = "pending" | "paid" | "failed" | "refunded" | "canceled";
export const ORDER_STATUSES: readonly OrderStatus[] = ["pending", "paid", "failed", "refunded", "canceled"];
export type PlanPeriod = "month" | "year";

export interface PlanView {
	id: string;
	name: string;
	period: PlanPeriod;
	priceCents: number;
	currency: string;
	monthlyCredits: number;
	features: Record<string, unknown>;
	active: boolean;
}

export interface PlanInput {
	name: string;
	period: PlanPeriod;
	priceCents: number;
	currency: string;
	monthlyCredits: number;
	features?: Record<string, unknown>;
	active?: boolean;
}

export interface PriceView {
	id: string;
	/** A model id, or "*" for the fallback row. */
	model: string;
	gatewayId: string | null;
	/** Credits per million tokens. */
	inputPrice: number;
	outputPrice: number;
	currencyNote: string | null;
}

export interface PriceInput {
	model: string;
	gatewayId?: string | null;
	inputPrice: number;
	outputPrice: number;
	currencyNote?: string | null;
}

export interface OrderView {
	id: string;
	subjectType: BillingSubjectType;
	subjectId: string;
	kind: OrderKind;
	amountCents: number;
	currency: string;
	credits: number;
	planId: string | null;
	status: OrderStatus;
	provider: string;
	providerRef: string | null;
	createdBy: string | null;
	createdAt: string;
	paidAt: string | null;
}

export interface GrantView {
	id: string;
	source: string;
	amount: number;
	remaining: number;
	expiresAt: string | null;
}

export interface BillingSummary {
	subject: { type: BillingSubjectType; id: string };
	balance: number;
	grants: GrantView[];
	plan: PlanView;
	subscription: { planId: string; status: string; currentPeriodStart: string; currentPeriodEnd: string; provider: string } | null;
	periodUsage: { credits: number; inputTokens: number; outputTokens: number; requests: number; overdraftCredits: number };
	recentOrders: OrderView[];
	providers: string[];
}

export interface CheckoutInput {
	kind: OrderKind;
	planId?: string;
	credits?: number;
	orgId?: string;
	provider?: string;
	successUrl?: string;
	cancelUrl?: string;
}

export interface CheckoutResult {
	orderId: string;
	status: OrderStatus;
	provider: string;
	/** Where to send the browser; null for offline providers (the order waits for an operator). */
	redirectUrl: string | null;
	amountCents: number;
	currency: string;
	credits: number;
}

export interface RedeemResult {
	credits: number;
	balance: number;
}

export interface OrderQuery {
	status?: OrderStatus;
	provider?: string;
	subjectType?: BillingSubjectType;
	subjectId?: string;
	before?: string;
	limit?: number;
}

export interface OrdersPage {
	items: OrderView[];
	nextBefore: string | null;
}

export interface RedeemCodeView {
	id: string;
	/** Last characters of the code; the full code is only shown once, when generated. */
	hint: string;
	credits: number;
	maxUses: number;
	usedCount: number;
	expiresAt: string | null;
	createdBy: string | null;
	createdAt: string;
}

export interface GenerateCodesInput {
	count: number;
	credits: number;
	maxUses?: number;
	expiresAt?: string | null;
}

export interface GeneratedCodes {
	/** Plaintext: shown once, never stored by the Hub. */
	codes: string[];
	credits: number;
	maxUses: number;
	expiresAt: string | null;
}

export interface BillingSettings {
	/** Credits one cent buys on top-up. */
	topupCreditsPerCent: number;
	currency: string;
	/** Top-up credits expire after this many days; null = never. */
	topupExpiryDays: number | null;
}

export interface GrantCreditsInput {
	subjectType: BillingSubjectType;
	subjectId: string;
	credits: number;
	expiresAt?: string | null;
}

// ---- Block 3: hybrid execution (where a session runs) and tenant runtimes (packages/hub services/exec.ts, runtime/*) ----

export type ExecLocation = "local" | "team";
export type ExecMode = "local-first" | "team-first";

/** `GET/PATCH /api/sessions/:id/exec` and the answer of a handoff. */
export interface ExecState {
	sessionId: string;
	location: ExecLocation;
	mode: ExecMode;
	/** Id of the session inside the owner's tenant instance, once it was handed to the team side. */
	tenantSessionId: string | null;
}

export type RuntimeStatus = "stopped" | "starting" | "running" | "stopping" | "failed";
export type RuntimeKind = "docker" | "sandbox" | "restricted";

export interface RuntimeView {
	userId: string;
	orgId: string | null;
	driver: RuntimeKind | null;
	nodeId: string | null;
	status: RuntimeStatus;
	port: number | null;
	containerId: string | null;
	pid: number | null;
	startedAt: string | null;
	lastSeenAt: string | null;
	cpuLimit: number | null;
	memLimitMb: number | null;
	lastError: string | null;
	/** Open proxied requests and WebSockets right now. */
	activeConnections: number;
	/** True while the tenant runs with limits older than the stored ones. */
	restartRequired: boolean;
}

/** `GET /api/runtime`: the caller's own tenant. `restricted` drives the restricted-mode badge. */
export interface MyRuntime extends RuntimeView {
	restricted: boolean;
	/** Absolute `<origin>/rt/` with a separate runtime origin, else host-relative `<basePath>/rt/`. Absent on an older Hub. */
	workbenchUrl?: string;
}

export interface DriverStatus {
	kind: RuntimeKind;
	available: boolean;
	reason?: string;
}

/** `GET /api/admin/runtimes`. */
export interface RuntimesListing {
	items: RuntimeView[];
	mode: "auto" | RuntimeKind;
	selected: RuntimeKind | null;
	drivers: DriverStatus[];
}

export type NodeStatus = "active" | "draining" | "offline";

export interface NodeView {
	id: string;
	name: string;
	dockerUrl: string;
	tlsDir?: string;
	cpuCapacity: number;
	memCapacityMb: number;
	status: NodeStatus;
	lastPingAt: string | null;
	createdAt: string;
	/** CPU and memory promised to tenants that are starting or running there. */
	allocatedCpu: number;
	allocatedMemMb: number;
	tenants: string[];
}

export interface NodeInput {
	name: string;
	dockerUrl: string;
	tlsDir?: string | null;
	cpuCapacity?: number;
	memCapacityMb?: number;
	status?: NodeStatus;
}

export interface RuntimeLimitsInput {
	cpuLimit?: number | null;
	memLimitMb?: number | null;
}
