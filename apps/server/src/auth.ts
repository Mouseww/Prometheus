import { readFileSync } from "node:fs";
import { canAct, ed25519PublicKey, identityFromClaims, verifyJwt } from "@prometheus/core";
import type { Identity } from "@prometheus/protocol";

/** A verified Hub token: who it names and when it stops being valid (seconds since the epoch, as in the token). */
export interface VerifiedToken {
	identity: Identity;
	exp: number;
}

/** Tolerance for token expiry and `nbf`, in seconds, unless `PROMETHEUS_TRUST_SKEW_SEC` says otherwise. */
const DEFAULT_SKEW_SEC = 60;

/** A pluggable way to recognise a caller beyond the token, password and loopback rules. */
export interface AuthProvider {
	/** Seconds past `exp` a token is still honoured; a connection it authenticated is closed at `exp + skewSec`. */
	readonly skewSec: number;
	verify(secret: string): Identity | undefined;
	/** Same check, keeping the expiry so a long-lived connection can be closed when the token runs out. */
	verifyToken(secret: string): VerifiedToken | undefined;
}

/** `@path` reads the key from a file; anything else is the PEM text itself. */
function readKey(value: string): string {
	return value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
}

/**
 * Trusts Hub-signed JWTs when `PROMETHEUS_TRUST_KEY` is set; otherwise there is no provider and nothing changes.
 * A key that cannot be read, parsed or is not an Ed25519 public key throws a Chinese error: starting without the
 * check the operator asked for would be worse than not starting.
 */
export function hubTrustFromEnv(env: NodeJS.ProcessEnv): AuthProvider | undefined {
	const raw = env.PROMETHEUS_TRUST_KEY?.trim();
	if (!raw) return undefined;
	let publicKey: ReturnType<typeof ed25519PublicKey>;
	try {
		publicKey = ed25519PublicKey(readKey(raw));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`PROMETHEUS_TRUST_KEY 无效：必须是 Ed25519 公钥（PEM 文本或 @文件路径）。${detail}`);
	}
	const issuer = env.PROMETHEUS_TRUST_ISSUER || undefined;
	const audience = env.PROMETHEUS_TRUST_AUDIENCE || undefined;
	const rawSkew = env.PROMETHEUS_TRUST_SKEW_SEC?.trim();
	const skewSec = rawSkew && /^\d+$/.test(rawSkew) ? Number(rawSkew) : DEFAULT_SKEW_SEC;
	const verifyToken = (secret: string): VerifiedToken | undefined => {
		const claims = verifyJwt(secret, { publicKey, clockSkewSec: skewSec, ...(issuer ? { issuer } : {}), ...(audience ? { audience } : {}) });
		return claims ? { identity: identityFromClaims(claims), exp: claims.exp } : undefined;
	};
	return { skewSec, verify: (secret) => verifyToken(secret)?.identity, verifyToken };
}

/** Milliseconds from `nowMs` until a token with expiry `exp` (seconds) plus `skewSec` has run out; never negative. */
export function msUntilExpiry(exp: number, skewSec: number, nowMs: number = Date.now()): number {
	return Math.max(0, (exp + skewSec) * 1000 - nowMs);
}

/** The signed-in clients allowed to act on a session owned by `owner` (everyone when it has no owner). Permission requests go to these only. */
export function actors<C extends { authed: boolean; identity?: Identity }>(clients: Iterable<C>, owner: string | undefined): C[] {
	const out: C[] = [];
	for (const c of clients) if (c.authed && canAct(c.identity, owner)) out.push(c);
	return out;
}

/** A trust key without a `serverOwner` in the policy would let any Hub user in, so the server refuses to start that way. */
export function requireServerOwner(trustKeySet: boolean, serverOwner: string | undefined): void {
	if (trustKeySet && !serverOwner) throw new Error("已配置 PROMETHEUS_TRUST_KEY，但策略（policy.json 或 PROMETHEUS_POLICY）中没有 serverOwner，已拒绝启动：必须指定服务器所有者");
}

/** A server with a policy `serverOwner` only admits that user (or someone acting for them) through a Hub token. */
export function identityAllowed(identity: Identity, serverOwner: string | undefined): boolean {
	if (!serverOwner) return true;
	return identity.userId === serverOwner || (identity.actsFor?.includes(serverOwner) ?? false);
}

export interface CredentialResult {
	ok: boolean;
	identity?: Identity;
	/** Expiry of the Hub token behind `identity`, in seconds since the epoch. */
	exp?: number;
}
