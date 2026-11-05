import type { Queryable } from "../db/db.ts";
import { forbidden, notFound } from "../errors.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "./audit.ts";
import { emailDomain, type ServiceDeps, scopeOf } from "./common.ts";

export interface RegistrationPolicy {
	allowOpen: boolean;
	allowedDomains: string[];
	requireApproval: boolean;
	allowInvite: boolean;
	closed: boolean;
}

export type RegistrationDecision =
	| { allowed: true; requireApproval: boolean }
	| { allowed: false; reason: "closed" | "domainNotAllowed" };

/** An organization without a stored policy adds no restriction and no approval step. */
export const UNRESTRICTED_ORG_POLICY: RegistrationPolicy = { allowOpen: true, allowedDomains: [], requireApproval: false, allowInvite: true, closed: false };

const domainAllowed = (p: RegistrationPolicy, email: string): boolean => p.allowOpen || p.allowedDomains.includes(emailDomain(email));

/**
 * Self-registration (no invite) must pass the platform policy and, when present, the organization policy;
 * approval is required if either asks for it. `closed` always wins.
 */
export function evaluateSelfRegistration(platform: RegistrationPolicy, org: RegistrationPolicy | undefined, email: string): RegistrationDecision {
	const policies = org ? [platform, org] : [platform];
	for (const p of policies) {
		if (p.closed) return { allowed: false, reason: "closed" };
		if (!domainAllowed(p, email)) return { allowed: false, reason: "domainNotAllowed" };
	}
	return { allowed: true, requireApproval: policies.some((p) => p.requireApproval) };
}

interface PolicyRow {
	allow_open: boolean;
	allowed_domains: string[];
	require_approval: boolean;
	allow_invite: boolean;
	closed: boolean;
}

const toPolicy = (r: PolicyRow): RegistrationPolicy => ({
	allowOpen: r.allow_open,
	allowedDomains: [...r.allowed_domains],
	requireApproval: r.require_approval,
	allowInvite: r.allow_invite,
	closed: r.closed,
});

export interface RegistrationService {
	/** Internal (system) reads used by the account flows. */
	platformPolicy(q?: Queryable): Promise<RegistrationPolicy>;
	orgPolicy(orgId: string, q?: Queryable): Promise<RegistrationPolicy | undefined>;
	getPlatform(actor: Actor): Promise<RegistrationPolicy>;
	putPlatform(actor: Actor, input: RegistrationPolicy): Promise<RegistrationPolicy>;
	getOrg(actor: Actor, orgId: string): Promise<RegistrationPolicy & { configured: boolean }>;
	putOrg(actor: Actor, orgId: string, input: RegistrationPolicy): Promise<RegistrationPolicy>;
}

export function createRegistrationService(deps: ServiceDeps, audit: AuditService): RegistrationService {
	const read = async (scope: "platform" | "org", scopeId: string, q?: Queryable): Promise<RegistrationPolicy | undefined> => {
		const rows = await (q ?? deps.db).query<PolicyRow>("SELECT * FROM registration_policies WHERE scope = $1 AND scope_id = $2", [scope, scopeId]);
		return rows[0] ? toPolicy(rows[0]) : undefined;
	};
	const normalized = (p: RegistrationPolicy): RegistrationPolicy => ({
		...p,
		allowedDomains: [...new Set(p.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))],
	});
	const upsert = async (actor: Actor, scope: "platform" | "org", scopeId: string, orgId: string | null, input: RegistrationPolicy): Promise<RegistrationPolicy> => {
		const p = normalized(input);
		await deps.db.tx(scopeOf(actor), async (q) => {
			await q.query(
				`INSERT INTO registration_policies (scope, scope_id, allow_open, allowed_domains, require_approval, allow_invite, closed)
				 VALUES ($1,$2,$3,$4::text[],$5,$6,$7)
				 ON CONFLICT (scope, scope_id) DO UPDATE SET allow_open = EXCLUDED.allow_open, allowed_domains = EXCLUDED.allowed_domains,
				   require_approval = EXCLUDED.require_approval, allow_invite = EXCLUDED.allow_invite, closed = EXCLUDED.closed, updated_at = now()`,
				[scope, scopeId, p.allowOpen, p.allowedDomains, p.requireApproval, p.allowInvite, p.closed],
			);
			await audit.write(q, { actorId: actor.userId, orgId, action: `registration.${scope}.update`, targetType: "registration_policy", targetId: scopeId, detail: { ...p } });
		});
		return p;
	};

	return {
		async platformPolicy(q) {
			const p = await read("platform", "platform", q);
			if (!p) throw new Error("平台注册策略缺失，迁移未完成");
			return p;
		},
		orgPolicy: (orgId, q) => read("org", orgId, q),
		async getPlatform(actor) {
			if (!can(actor, "platform.manage")) throw forbidden();
			return this.platformPolicy();
		},
		async putPlatform(actor, input) {
			if (!can(actor, "platform.manage")) throw forbidden();
			return upsert(actor, "platform", "platform", null, input);
		},
		async getOrg(actor, orgId) {
			if (!can(actor, "org.registration.manage", { orgId })) throw forbidden();
			const exists = await deps.db.tx(scopeOf(actor), (q) => q.query("SELECT 1 FROM organizations WHERE id = $1", [orgId]));
			if (exists.length === 0) throw notFound("企业不存在");
			const p = await read("org", orgId);
			return p ? { ...p, configured: true } : { ...UNRESTRICTED_ORG_POLICY, configured: false };
		},
		async putOrg(actor, orgId, input) {
			if (!can(actor, "org.registration.manage", { orgId })) throw forbidden();
			const exists = await deps.db.tx(scopeOf(actor), (q) => q.query("SELECT 1 FROM organizations WHERE id = $1", [orgId]));
			if (exists.length === 0) throw notFound("企业不存在");
			return upsert(actor, "org", orgId, orgId, input);
		},
	};
}
