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
