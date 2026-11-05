import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import type { Identity } from "@prometheus/protocol";

/** Claims of a Hub-issued token. `exp` is mandatory: a token that never expires is rejected. */
export interface JwtClaims {
	sub: string;
	name?: string;
	org?: string;
	acts_for?: string[];
	iss?: string;
	aud?: string;
	exp: number;
	iat: number;
	nbf?: number;
	jti?: string;
}

export interface VerifyOptions {
	publicKey: KeyObject | string;
	issuer?: string;
	audience?: string;
	/** Seconds since the epoch; defaults to the current time. */
	now?: number;
	/** Tolerance for `exp` and `nbf`, in seconds (default 60). */
	clockSkewSec?: number;
}

const b64 = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** Signs claims as a compact EdDSA (Ed25519) JWT. */
export function signJwt(claims: JwtClaims, privateKey: KeyObject | string): string {
	const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
	const head = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
	const body = b64(JSON.stringify(claims));
	const signature = sign(null, Buffer.from(`${head}.${body}`), key);
	return `${head}.${body}.${b64(signature)}`;
}

function parseJson(segment: string): unknown {
	try {
		return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
	} catch {
		return undefined;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks a token and returns its claims; anything invalid yields `undefined` and never throws. */
export function verifyJwt(token: string, opts: VerifyOptions): JwtClaims | undefined {
	try {
		if (typeof token !== "string") return undefined;
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const [head, body, sig] = parts as [string, string, string];
		const header = parseJson(head);
		if (!isRecord(header) || header.alg !== "EdDSA") return undefined;
		if (header.typ !== undefined && header.typ !== "JWT") return undefined;
		const key = typeof opts.publicKey === "string" ? createPublicKey(opts.publicKey) : opts.publicKey;
		if (!verify(null, Buffer.from(`${head}.${body}`), key, Buffer.from(sig, "base64url"))) return undefined;
		const claims = parseJson(body);
		if (!isRecord(claims)) return undefined;
		if (typeof claims.sub !== "string" || !claims.sub) return undefined;
		if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return undefined;
		const now = opts.now ?? Math.floor(Date.now() / 1000);
		const skew = opts.clockSkewSec ?? 60;
		if (now > claims.exp + skew) return undefined;
		if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || now < claims.nbf - skew)) return undefined;
		if (opts.issuer !== undefined && claims.iss !== opts.issuer) return undefined;
		if (opts.audience !== undefined && claims.aud !== opts.audience) return undefined;
		if (claims.acts_for !== undefined && !(Array.isArray(claims.acts_for) && claims.acts_for.every((s) => typeof s === "string"))) return undefined;
		return claims as unknown as JwtClaims;
	} catch {
		return undefined;
	}
}

export function identityFromClaims(c: JwtClaims): Identity {
	return {
		userId: c.sub,
		...(c.name !== undefined ? { name: c.name } : {}),
		...(c.org !== undefined ? { orgId: c.org } : {}),
		...(c.acts_for?.length ? { actsFor: [...c.acts_for] } : {}),
	};
}

/** A fresh Ed25519 key pair as PEM text. */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	return {
		publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
}
