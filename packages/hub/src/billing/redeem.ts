import { randomBytes } from "node:crypto";
import { sha256Hex } from "../crypto.ts";
import { toIso } from "../db/db.ts";
import { badRequest, conflict, forbidden, HubError, notFound, tooManyRequests } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { RateLimiter } from "../rate-limit.ts";
import type { AuditService } from "../services/audit.ts";
import { type ServiceDeps, scopeOf } from "../services/common.ts";
import type { Subject } from "./providers/provider.ts";
import { balanceOf } from "./wallet.ts";

export const MAX_CODES_PER_BATCH = 1000;
const REDEEM_ATTEMPTS_PER_HOUR = 20;
/** Crockford base32 without I, L, O, U: easy to read out and type. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface GenerateCodesInput {
	count: number;
	credits: number;
	maxUses?: number;
	expiresAt?: string | null;
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

export interface RedeemService {
	/** Returns the plaintext codes; only their hashes are stored. */
	generate(actor: Actor, input: GenerateCodesInput): Promise<{ codes: string[]; credits: number; maxUses: number; expiresAt: string | null }>;
	list(actor: Actor): Promise<RedeemCodeView[]>;
	redeem(actor: Actor, subject: Subject, code: string): Promise<{ credits: number; balance: number }>;
}

/** Upper-case, without separators or spaces: what gets hashed. */
export const normalizeCode = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase();

function newCode(): string {
	const bytes = randomBytes(16);
	let out = "";
	for (let i = 0; i < 16; i++) out += ALPHABET[(bytes[i] as number) & 31];
	return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}

interface CodeRow {
	id: string;
	hint: string;
	credits: string | number;
	max_uses: number;
	used_count: number;
	expires_at: Date | string | null;
	created_by: string | null;
	created_at: Date | string;
}

export function createRedeemService(deps: ServiceDeps, audit: AuditService, limiter: RateLimiter): RedeemService {
	return {
		async generate(actor, input) {
			if (!can(actor, "platform.manage")) throw forbidden();
			if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) throw badRequest("expiresAt 不是有效的日期", "validationError");
			const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
			const maxUses = input.maxUses ?? 1;
			const codes = Array.from({ length: input.count }, newCode);
			await deps.db.tx(scopeOf(actor), async (q) => {
				for (const code of codes) {
					await q.query("INSERT INTO redeem_codes (id, code_hash, hint, credits, max_uses, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7)", [
						ulid(deps.now()),
						sha256Hex(normalizeCode(code)),
						normalizeCode(code).slice(-4),
						input.credits,
						maxUses,
						expiresAt,
						actor.userId,
					]);
				}
				await audit.write(q, { actorId: actor.userId, action: "redeem.generate", targetType: "redeem", detail: { count: input.count, credits: input.credits, maxUses, expiresAt } });
			});
			return { codes, credits: input.credits, maxUses, expiresAt };
		},

		async list(actor) {
			if (!can(actor, "platform.manage")) throw forbidden();
			const rows = await deps.db.tx(scopeOf(actor), (q) =>
				q.query<CodeRow>("SELECT id, hint, credits, max_uses, used_count, expires_at, created_by, created_at FROM redeem_codes ORDER BY id DESC LIMIT 1000"),
			);
			return rows.map((r) => ({
				id: r.id,
				hint: r.hint,
				credits: Number(r.credits),
				maxUses: r.max_uses,
				usedCount: r.used_count,
				expiresAt: toIso(r.expires_at),
				createdBy: r.created_by,
				createdAt: toIso(r.created_at) as string,
			}));
		},

		async redeem(actor, subject, rawCode) {
			const limit = limiter.hit(`redeem:${actor.userId}`, REDEEM_ATTEMPTS_PER_HOUR, 60 * 60 * 1000);
			if (!limit.allowed) throw tooManyRequests(limit.retryAfterSec);
			const code = normalizeCode(rawCode);
			if (!/^[0-9A-Z]{8,64}$/.test(code)) throw new HubError(404, "invalidCode", "兑换码无效");
			const nowMs = deps.now();
			return deps.db.tx({ system: true }, async (q) => {
				const rows = await q.query<CodeRow>("SELECT id, hint, credits, max_uses, used_count, expires_at, created_by, created_at FROM redeem_codes WHERE code_hash = $1 FOR UPDATE", [sha256Hex(code)]);
				const row = rows[0];
				if (!row) throw new HubError(404, "invalidCode", "兑换码无效");
				if (row.expires_at && new Date(row.expires_at).getTime() <= nowMs) throw new HubError(410, "codeExpired", "兑换码已过期");
				if (row.used_count >= row.max_uses) throw conflict("兑换码已被用完", "codeExhausted");
				const done = await q.query("SELECT 1 FROM redeem_redemptions WHERE code_id = $1 AND user_id = $2", [row.id, actor.userId]);
				if (done.length > 0) throw conflict("你已经兑换过这个兑换码", "codeAlreadyRedeemed");
				if (subject.type === "org") {
					const org = await q.query("SELECT 1 FROM organizations WHERE id = $1", [subject.id]);
					if (org.length === 0) throw notFound("企业不存在");
				}
				const credits = Number(row.credits);
				await q.query("INSERT INTO redeem_redemptions (code_id, user_id, subject_type, subject_id) VALUES ($1,$2,$3,$4)", [row.id, actor.userId, subject.type, subject.id]);
				await q.query("UPDATE redeem_codes SET used_count = used_count + 1 WHERE id = $1", [row.id]);
				await q.query("INSERT INTO credit_grants (id, subject_type, subject_id, source, amount, remaining, ref) VALUES ($1,$2,$3,'redeem',$4,$4,$5)", [
					ulid(nowMs),
					subject.type,
					subject.id,
					credits,
					`${row.id}:${actor.userId}`,
				]);
				await audit.write(q, {
					actorId: actor.userId,
					orgId: subject.type === "org" ? subject.id : null,
					action: "redeem.use",
					targetType: "redeem",
					targetId: row.id,
					detail: { credits, subjectType: subject.type },
				});
				return { credits, balance: await balanceOf(q, subject, new Date(nowMs).toISOString()) };
			});
		},
	};
}
