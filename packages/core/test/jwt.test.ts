import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519PublicKey, generateKeyPair, identityFromClaims, type JwtClaims, signJwt, verifyJwt } from "../src/identity/jwt.ts";

const keys = generateKeyPair();
const now = 1_800_000_000;
const claims = (over: Partial<JwtClaims> = {}): JwtClaims => ({ sub: "u1", name: "Ann", org: "o1", iss: "hub", aud: "srv", iat: now, exp: now + 600, ...over });
const verifyAt = (token: string, extra: Record<string, unknown> = {}) => verifyJwt(token, { publicKey: keys.publicKey, now, ...extra });

describe("jwt", () => {
	it("round-trips claims", () => {
		const token = signJwt(claims(), keys.privateKey);
		expect(verifyAt(token, { issuer: "hub", audience: "srv" })).toEqual(claims());
	});
	it("rejects an expired token beyond the skew", () => {
		const token = signJwt(claims({ exp: now - 120 }), keys.privateKey);
		expect(verifyAt(token)).toBeUndefined();
		expect(verifyAt(signJwt(claims({ exp: now - 30 }), keys.privateKey))).toBeDefined();
	});
	it("rejects a token that is not valid yet", () => {
		expect(verifyAt(signJwt(claims({ nbf: now + 300 }), keys.privateKey))).toBeUndefined();
		expect(verifyAt(signJwt(claims({ nbf: now + 30 }), keys.privateKey))).toBeDefined();
	});
	it("rejects a bad signature", () => {
		const other = generateKeyPair();
		expect(verifyAt(signJwt(claims(), other.privateKey))).toBeUndefined();
		const token = signJwt(claims(), keys.privateKey);
		const [h, , s] = token.split(".");
		const forged = Buffer.from(JSON.stringify(claims({ sub: "admin" }))).toString("base64url");
		expect(verifyAt(`${h}.${forged}.${s}`)).toBeUndefined();
	});
	it("rejects a non-EdDSA alg", () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
		const body = Buffer.from(JSON.stringify(claims())).toString("base64url");
		const sig = sign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
		expect(verifyAt(`${head}.${body}.${sig}`)).toBeUndefined();
		expect(verifyAt(`${head}.${body}.`)).toBeUndefined();
	});
	it("rejects issuer and audience mismatches", () => {
		const token = signJwt(claims(), keys.privateKey);
		expect(verifyAt(token, { issuer: "evil" })).toBeUndefined();
		expect(verifyAt(token, { audience: "other" })).toBeUndefined();
	});
	it("rejects a missing exp and garbage without throwing", () => {
		const { exp: _exp, ...rest } = claims();
		expect(verifyAt(signJwt(rest as JwtClaims, keys.privateKey))).toBeUndefined();
		expect(verifyAt("nonsense")).toBeUndefined();
		expect(verifyJwt("a.b.c", { publicKey: "not a key" })).toBeUndefined();
	});
	it("rejects keys that are not Ed25519 public keys", () => {
		const token = signJwt(claims(), keys.privateKey);
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const x448 = generateKeyPairSync("ed448");
		for (const publicKey of [rsa.publicKey, ec.publicKey, x448.publicKey]) expect(verifyAt(token, { publicKey })).toBeUndefined();
		// A private key object is not a public key either.
		expect(verifyAt(token, { publicKey: createPrivateKey(keys.privateKey) })).toBeUndefined();
		expect(verifyAt(token, { publicKey: createPublicKey(keys.publicKey) })).toBeDefined();
	});
	it("checks an Ed25519 public key up front", () => {
		expect(ed25519PublicKey(keys.publicKey).asymmetricKeyType).toBe("ed25519");
		expect(() => ed25519PublicKey("not a key")).toThrow();
		expect(() => ed25519PublicKey(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow(/ed25519/i);
		expect(() => ed25519PublicKey(keys.privateKey)).toThrow();
	});
	it("maps claims to an identity", () => {
		expect(identityFromClaims(claims({ acts_for: ["x"] }))).toEqual({ userId: "u1", name: "Ann", orgId: "o1", actsFor: ["x"] });
		expect(identityFromClaims({ sub: "u2", iat: 1, exp: 2 })).toEqual({ userId: "u2" });
	});
});
