import type { Queryable } from "../db/db.ts";
import { conflict, forbidden, notFound, tooManyRequests } from "../errors.ts";
import { type Actor, can } from "../permissions.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { AuditService } from "./audit.ts";
import { emailDomain, type ServiceDeps } from "./common.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const REGISTER_PER_IP_PER_HOUR = 5;
export const REGISTER_PER_SUBNET_PER_DAY = 50;

/** Small built-in list; operators extend it through `/api/admin/disposable-domains`. */
export const BUILTIN_DISPOSABLE_DOMAINS: readonly string[] = [
	"mailinator.com",
	"guerrillamail.com",
	"guerrillamail.net",
	"10minutemail.com",
	"tempmail.com",
	"temp-mail.org",
	"yopmail.com",
	"trashmail.com",
	"throwawaymail.com",
	"getnada.com",
	"sharklasers.com",
	"maildrop.cc",
	"dispostable.com",
	"fakeinbox.com",
	"mintemail.com",
];

/** `203.0.113.7` -> `203.0.113.0/24`; IPv6 -> its /48; unparseable input is used verbatim. */
export function subnetKey(ip: string): string {
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
	const v4 = mapped?.[1] ?? ip;
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4)) return `${v4.split(".").slice(0, 3).join(".")}.0/24`;
	if (ip.includes(":")) {
		const groups = expandIpv6(ip);
		if (groups) return `${groups.slice(0, 3).join(":")}::/48`;
	}
	return ip;
}

function expandIpv6(ip: string): string[] | undefined {
	const zone = ip.split("%")[0] as string;
	const halves = zone.split("::");
	if (halves.length > 2) return undefined;
	const head = (halves[0] ?? "").split(":").filter(Boolean);
	const tail = (halves[1] ?? "").split(":").filter(Boolean);
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined;
	const all = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill("0"), ...tail];
	return all.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""));
}

export interface DisposableDomainView {
	domain: string;
	createdAt: string;
}

export interface AbuseGuard {
	/** Counts one registration attempt; throws 429 when the IP or its subnet is over the limit. */
	checkRegistrationRate(ip: string): void;
	/** Rejects built-in or operator-listed throwaway mail domains. */
	assertEmailAllowed(email: string, q?: Queryable): Promise<void>;
	listDomains(actor: Actor): Promise<DisposableDomainView[]>;
	addDomain(actor: Actor, domain: string): Promise<DisposableDomainView>;
	removeDomain(actor: Actor, domain: string): Promise<void>;
}

export function createAbuseGuard(deps: ServiceDeps, limiter: RateLimiter, audit: AuditService): AbuseGuard {
	const normalizeDomain = (domain: string): string => domain.trim().toLowerCase().replace(/^@/, "");
	const view = (r: { domain: string; created_at: Date | string }): DisposableDomainView => ({ domain: r.domain, createdAt: new Date(r.created_at).toISOString() });

	return {
		checkRegistrationRate(ip) {
			const perIp = limiter.hit(`reg:ip:${ip}`, REGISTER_PER_IP_PER_HOUR, HOUR_MS);
			if (!perIp.allowed) throw tooManyRequests(perIp.retryAfterSec);
			const perNet = limiter.hit(`reg:net:${subnetKey(ip)}`, REGISTER_PER_SUBNET_PER_DAY, DAY_MS);
			if (!perNet.allowed) throw tooManyRequests(perNet.retryAfterSec);
		},

		async assertEmailAllowed(email, q) {
			const domain = emailDomain(email);
			const blocked =
				BUILTIN_DISPOSABLE_DOMAINS.includes(domain) || (await (q ?? deps.db).query("SELECT 1 FROM disposable_email_domains WHERE domain = $1", [domain])).length > 0;
			if (blocked) throw forbidden("不支持使用一次性邮箱注册", "disposableEmail");
		},

		async listDomains(actor) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const rows = await deps.db.query<{ domain: string; created_at: Date | string }>("SELECT domain, created_at FROM disposable_email_domains ORDER BY domain");
			return rows.map(view);
		},

		async addDomain(actor, domain) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const d = normalizeDomain(domain);
			return deps.db.tx({ system: true }, async (q) => {
				const exists = await q.query("SELECT 1 FROM disposable_email_domains WHERE domain = $1", [d]);
				if (exists.length > 0) throw conflict("该域名已在黑名单中", "domainExists");
				const rows = await q.query<{ domain: string; created_at: Date | string }>(
					"INSERT INTO disposable_email_domains (domain, created_by) VALUES ($1,$2) RETURNING domain, created_at",
					[d, actor.userId],
				);
				await audit.write(q, { actorId: actor.userId, action: "abuse.domain.add", targetType: "disposable_domain", targetId: d });
				return view(rows[0] as { domain: string; created_at: Date | string });
			});
		},

		async removeDomain(actor, domain) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const d = normalizeDomain(domain);
			await deps.db.tx({ system: true }, async (q) => {
				const removed = await q.query("DELETE FROM disposable_email_domains WHERE domain = $1 RETURNING domain", [d]);
				if (removed.length === 0) throw notFound("域名不在黑名单中");
				await audit.write(q, { actorId: actor.userId, action: "abuse.domain.remove", targetType: "disposable_domain", targetId: d });
			});
		},
	};
}
