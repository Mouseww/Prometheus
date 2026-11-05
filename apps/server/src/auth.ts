import { readFileSync } from "node:fs";
import { identityFromClaims, verifyJwt } from "@prometheus/core";
import type { Identity } from "@prometheus/protocol";

/** A pluggable way to recognise a caller beyond the token, password and loopback rules. */
export interface AuthProvider {
	verify(secret: string): Identity | undefined;
}

/** `@path` reads the key from a file; anything else is the PEM text itself. */
function readKey(value: string): string {
	return value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
}

/** Trusts Hub-signed JWTs when `PROMETHEUS_TRUST_KEY` is set; otherwise there is no provider and nothing changes. */
export function hubTrustFromEnv(env: NodeJS.ProcessEnv): AuthProvider | undefined {
	const raw = env.PROMETHEUS_TRUST_KEY?.trim();
	if (!raw) return undefined;
	const publicKey = readKey(raw);
	const issuer = env.PROMETHEUS_TRUST_ISSUER || undefined;
	const audience = env.PROMETHEUS_TRUST_AUDIENCE || undefined;
	return {
		verify(secret: string): Identity | undefined {
			const claims = verifyJwt(secret, { publicKey, ...(issuer ? { issuer } : {}), ...(audience ? { audience } : {}) });
			return claims ? identityFromClaims(claims) : undefined;
		},
	};
}

/** A server with a policy `serverOwner` only admits that user (or someone acting for them) through a Hub token. */
export function identityAllowed(identity: Identity, serverOwner: string | undefined): boolean {
	if (!serverOwner) return true;
	return identity.userId === serverOwner || (identity.actsFor?.includes(serverOwner) ?? false);
}

export interface CredentialResult {
	ok: boolean;
	identity?: Identity;
}
