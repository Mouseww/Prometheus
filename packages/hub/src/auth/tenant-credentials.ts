import type { Db } from "../db/db.ts";
import type { JwtClaims } from "../jwt.ts";
import { verifyJwt } from "../jwt.ts";
import { ulid } from "../ids.ts";

/** Audience of the long-lived credential a tenant instance's team plugin presents to the Hub. */
export const TENANT_TOKEN_AUDIENCE = "prometheus-tenant";
/** Audience of the token a tenant's server presents to the LLM proxy. Accepted by `/llm` only, never by the API. */
export const LLM_AUDIENCE = "prometheus-llm";
/** `scope` claim of access tokens minted for a tenant instance. */
export const TENANT_SCOPE = "tenant";

export type CredentialKind = "tenant" | "gateway";

export interface IssuedCredential {
	token: string;
	jti: string;
	exp: number;
}

export interface TenantCredentials {
	/** Signs a credential for the user and records its jti. */
	issue(userId: string, kind: CredentialKind, ttlSec: number): Promise<IssuedCredential>;
	/** Mints the short-lived access token (scope tenant, linked to the credential `cid`) the tenant-token endpoint hands out. */
	accessTokenClaims(cred: JwtClaims): { jti: string; cid: string; scope: string };
	/** True while the credential exists, is not revoked and has not expired. */
	isActive(jti: string | undefined): Promise<boolean>;
	/** Verifies a tenant credential or gateway token (signature, audience, expiry) and that its jti is still active. */
	verify(token: string, kind: CredentialKind): Promise<JwtClaims | undefined>;
	/** Whether a verified access token is still valid: plain tokens always, scope-tenant tokens only while their credential is. */
	accessTokenActive(claims: JwtClaims): Promise<boolean>;
	/** Revokes every live credential of the user (optionally one kind); returns how many were revoked. */
	revokeUser(userId: string, kind?: CredentialKind): Promise<number>;
}

export interface TenantCredentialsDeps {
	db: Db;
	publicKey: string;
	issuer: string;
	now: () => number;
	signToken(claims: Omit<JwtClaims, "iss" | "iat"> & Record<string, unknown>): string;
}

export function createTenantCredentials(deps: TenantCredentialsDeps): TenantCredentials {
	const nowDate = (): Date => new Date(deps.now());

	async function isActive(jti: string | undefined): Promise<boolean> {
		if (!jti) return false;
		const rows = await deps.db.tx({ system: true }, (q) =>
			// A disabled or banned account loses its credentials at once, without anyone having to revoke them.
			q.query(
				`SELECT 1 FROM tenant_credentials c JOIN users u ON u.id = c.user_id
				 WHERE c.jti = $1 AND c.revoked_at IS NULL AND c.expires_at > $2 AND u.status = 'active'`,
				[jti, nowDate()],
			),
		);
		return rows.length > 0;
	}

	return {
		async issue(userId, kind, ttlSec) {
			const jti = ulid(deps.now());
			const exp = Math.floor(deps.now() / 1000) + ttlSec;
			const audience = kind === "tenant" ? TENANT_TOKEN_AUDIENCE : LLM_AUDIENCE;
			await deps.db.tx({ system: true }, async (q) => {
				await q.query("INSERT INTO tenant_credentials (jti, user_id, kind, expires_at) VALUES ($1,$2,$3,$4)", [jti, userId, kind, new Date(exp * 1000)]);
				// Expired rows are of no use any more.
				await q.query("DELETE FROM tenant_credentials WHERE expires_at < $1", [new Date(deps.now() - 24 * 60 * 60 * 1000)]);
			});
			const token = deps.signToken({ sub: userId, aud: audience, jti, exp, ...(kind === "tenant" ? { tenant: true } : {}) });
			return { token, jti, exp };
		},

		accessTokenClaims(cred) {
			return { jti: ulid(deps.now()), cid: cred.jti as string, scope: TENANT_SCOPE };
		},

		isActive,

		async verify(token, kind) {
			const claims = verifyJwt(token, { publicKey: deps.publicKey, issuer: deps.issuer, audience: kind === "tenant" ? TENANT_TOKEN_AUDIENCE : LLM_AUDIENCE, now: Math.floor(deps.now() / 1000) });
			if (!claims) return undefined;
			if (kind === "tenant" && claims.tenant !== true) return undefined;
			return (await isActive(claims.jti)) ? claims : undefined;
		},

		async accessTokenActive(claims) {
			if (claims.scope !== TENANT_SCOPE) return true;
			return isActive(claims.cid);
		},

		async revokeUser(userId, kind) {
			const rows = await deps.db.tx({ system: true }, (q) =>
				q.query<{ jti: string }>(
					`UPDATE tenant_credentials SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL ${kind ? "AND kind = $3" : ""} RETURNING jti`,
					kind ? [userId, nowDate(), kind] : [userId, nowDate()],
				),
			);
			return rows.length;
		},
	};
}
