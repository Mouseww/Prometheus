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
}

export interface RegisterInput {
	email: string;
	password: string;
	displayName: string;
	setupCode?: string;
	inviteToken?: string;
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
