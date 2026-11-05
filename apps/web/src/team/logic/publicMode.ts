// Pure helpers for the Hub's public online-service mode: what /api/meta says, link pages, context scoping and transfers.
import type { MeResult, MetaInfo, TeamView, TransferView } from "../types.ts";

// ---- /api/meta ----

export const isPublicMode = (meta: MetaInfo | undefined): boolean => meta?.mode === "public";

/** The sign-up form must carry a Turnstile token: required by the Hub, with a site key, and not the bootstrap account. */
export function needsTurnstile(meta: MetaInfo | undefined): boolean {
	return Boolean(meta && meta.turnstileRequired === true && meta.turnstileSiteKey && !meta.needsSetup);
}

/**
 * Whether the billing UI should exist, decided without calling a billing endpoint (which logs a 404 in the console when off).
 * Billing is always on in public mode. In private mode the Hub only enables it with HUB_BILLING=on, which /api/meta does not
 * report yet, so an explicit `billingEnabled` is honoured when present and otherwise private mode counts as off.
 * `undefined` means "unknown, ask the Hub" (member mode, or an old Hub without `mode`).
 */
export function billingFromMeta(meta: MetaInfo | undefined): boolean | undefined {
	if (!meta) return undefined;
	if (typeof meta.billingEnabled === "boolean") return meta.billingEnabled;
	if (meta.mode === "public") return true;
	if (meta.mode === "private") return false;
	return undefined;
}

/** Operators get a warning when mail only goes to the Hub log. Unknown (old Hub) is not a warning. */
export const mailWarning = (meta: MetaInfo | undefined): boolean => meta?.mailConfigured === false;

/** Verification matters in public mode only; an unverified signed-in user sees the banner. */
export const needsVerificationBanner = (me: MeResult, meta: MetaInfo | undefined): boolean => isPublicMode(meta) && me.user.emailVerifiedAt === null;

/** Self-service organization creation: the operator always, anyone else only in public mode when the operator allows it. */
export function canCreateOrg(me: MeResult, meta: MetaInfo | undefined): boolean {
	if (me.user.platformRole === "operator") return true;
	return isPublicMode(meta) && meta?.allowSelfCreateOrg === true;
}

// ---- links the Hub mails out ----

export type AuthLink = { kind: "verify-email"; token: string } | { kind: "reset-password"; token: string };

/** `/verify-email?token=..` and `/reset-password?token=..` (paths built by packages/hub/src/services/accounts-public.ts). */
export function authLinkFromLocation(pathname: string, search: string): AuthLink | undefined {
	const m = /^\/(verify-email|reset-password)\/?$/.exec(pathname);
	if (!m) return undefined;
	const token = new URLSearchParams(search).get("token");
	if (!token) return undefined;
	return { kind: m[1] as AuthLink["kind"], token };
}

/** Where the address bar goes once a one-time link (invitation, verification, reset) has been used. */
export const APP_ROOT = "/";

export function isOneTimeLinkPath(pathname: string): boolean {
	return /^\/(invite\/[^/]+|verify-email|reset-password)\/?$/.test(pathname);
}

// ---- context switcher ----

/** "all", "personal" or "org:<id>". */
export type Scope = string;

export const SCOPE_ALL: Scope = "all";
export const SCOPE_PERSONAL: Scope = "personal";
export const orgScope = (orgId: string): Scope => `org:${orgId}`;

export function orgIdOfScope(scope: Scope): string | undefined {
	return scope.startsWith("org:") ? scope.slice(4) : undefined;
}

/** A scope that points at an organization the user no longer belongs to falls back to "all". */
export function validScope(scope: Scope, me: MeResult): Scope {
	const orgId = orgIdOfScope(scope);
	if (orgId !== undefined) return me.orgs.some((o) => o.id === orgId) ? scope : SCOPE_ALL;
	return scope === SCOPE_PERSONAL ? scope : SCOPE_ALL;
}

export function filterTeamsByScope(teams: readonly TeamView[], scope: Scope): TeamView[] {
	if (scope === SCOPE_PERSONAL) return teams.filter((t) => t.orgId === null);
	const orgId = orgIdOfScope(scope);
	if (orgId !== undefined) return teams.filter((t) => t.orgId === orgId);
	return [...teams];
}

// ---- team transfers ----

export interface TransferRow {
	transfer: TransferView;
	/** The viewer may accept or reject (administers the target organization, or is an operator). */
	canDecide: boolean;
	/** The viewer made the request and it is still pending. */
	canCancel: boolean;
}

/** Pending first (newest first inside each group), with the actions the viewer has on each. */
export function transferRows(list: readonly TransferView[], me: MeResult): TransferRow[] {
	const operator = me.user.platformRole === "operator";
	const admin = new Set(me.orgs.filter((o) => o.role === "owner" || o.role === "admin").map((o) => o.id));
	const rows = list.map((transfer) => {
		const pending = transfer.status === "pending";
		return {
			transfer,
			canDecide: pending && (operator || admin.has(transfer.toOrgId)),
			canCancel: pending && transfer.fromUserId === me.user.id,
		};
	});
	return rows.sort((a, b) => {
		const pa = a.transfer.status === "pending" ? 0 : 1;
		const pb = b.transfer.status === "pending" ? 0 : 1;
		if (pa !== pb) return pa - pb;
		return b.transfer.createdAt.localeCompare(a.transfer.createdAt);
	});
}

/** Requests waiting for the viewer's decision. */
export const pendingDecisions = (rows: readonly TransferRow[]): number => rows.filter((r) => r.canDecide).length;

/** The pending request for a team, if any. */
export const pendingTransferFor = (list: readonly TransferView[], teamId: string): TransferView | undefined => list.find((t) => t.teamId === teamId && t.status === "pending");

/** Organizations a personal team could move into: the ones the viewer belongs to. */
export const transferTargets = (me: MeResult): { id: string; name: string }[] => me.orgs.map((o) => ({ id: o.id, name: o.name }));

export function transferTone(status: TransferView["status"]): "ember" | "moss" | "rose" | "muted" {
	return status === "pending" ? "ember" : status === "accepted" ? "moss" : status === "rejected" ? "rose" : "muted";
}

// ---- disposable domains ----

/** "@Example.com " to "example.com"; undefined when it does not look like a domain. */
export function normalizeDomainInput(raw: string): string | undefined {
	const d = raw.trim().toLowerCase().replace(/^@/, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/.test(d) && d.length <= 253 ? d : undefined;
}
