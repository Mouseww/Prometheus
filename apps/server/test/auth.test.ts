import { generateKeyPairSync } from "node:crypto";
import { generateKeyPair, signJwt } from "@prometheus/core";
import { describe, expect, it } from "vitest";
import { actors, hubTrustFromEnv, identityAllowed, msUntilExpiry, requireServerOwner } from "../src/auth.ts";

const keys = generateKeyPair();
const exp = Math.floor(Date.now() / 1000) + 600;
const token = (extra = {}) => signJwt({ sub: "u1", iat: exp - 600, exp, iss: "hub", aud: "srv", ...extra }, keys.privateKey);

describe("hubTrustFromEnv", () => {
	it("is off without a key", () => {
		expect(hubTrustFromEnv({})).toBeUndefined();
		expect(hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: "  " })).toBeUndefined();
	});
	it("verifies a Hub token and maps the identity", () => {
		const p = hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: keys.publicKey, PROMETHEUS_TRUST_ISSUER: "hub", PROMETHEUS_TRUST_AUDIENCE: "srv" });
		expect(p?.verify(token())).toEqual({ userId: "u1" });
		expect(p?.verify(token({ iss: "other" }))).toBeUndefined();
		expect(p?.verify("plain-token")).toBeUndefined();
	});
});

describe("trust key validation", () => {
	it("refuses to start on an unparsable key or a key of another type", () => {
		expect(() => hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: "not a pem" })).toThrow(/PROMETHEUS_TRUST_KEY/);
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
		expect(() => hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: rsa })).toThrow(/Ed25519/);
		expect(() => hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: keys.privateKey })).toThrow(/PROMETHEUS_TRUST_KEY/);
		expect(() => hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: "@/definitely/not/here.pem" })).toThrow(/PROMETHEUS_TRUST_KEY/);
	});
	it("returns the expiry with the identity", () => {
		const p = hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: keys.publicKey });
		expect(p?.verifyToken(token())).toEqual({ identity: { userId: "u1" }, exp });
		expect(p?.verifyToken("plain")).toBeUndefined();
	});
});

describe("expiry and audience helpers", () => {
	it("reads the skew from the environment, 60 seconds by default", () => {
		expect(hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: keys.publicKey })?.skewSec).toBe(60);
		expect(hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: keys.publicKey, PROMETHEUS_TRUST_SKEW_SEC: "5" })?.skewSec).toBe(5);
		expect(hubTrustFromEnv({ PROMETHEUS_TRUST_KEY: keys.publicKey, PROMETHEUS_TRUST_SKEW_SEC: "-1" })?.skewSec).toBe(60);
	});
	it("counts the time until exp plus skew from an injected clock", () => {
		expect(msUntilExpiry(1000, 60, 1_000_000)).toBe(60_000);
		expect(msUntilExpiry(1000, 0, 1_000_000)).toBe(0);
		expect(msUntilExpiry(1000, 0, 2_000_000)).toBe(0);
		expect(msUntilExpiry(1000, 60, 990_000)).toBe(70_000);
	});
	it("sends permission requests only to signed-in clients that may act", () => {
		const clients = [
			{ name: "machine", authed: true },
			{ name: "owner", authed: true, identity: { userId: "alice" } },
			{ name: "delegate", authed: true, identity: { userId: "hub", actsFor: ["alice"] } },
			{ name: "other", authed: true, identity: { userId: "bob" } },
			{ name: "pending", authed: false },
		];
		expect(actors(clients, "alice").map((c) => c.name)).toEqual(["machine", "owner", "delegate"]);
		expect(actors(clients, undefined).map((c) => c.name)).toEqual(["machine", "owner", "delegate", "other"]);
	});
});

describe("requireServerOwner", () => {
	it("needs a serverOwner whenever a trust key is set", () => {
		expect(() => requireServerOwner(true, undefined)).toThrow(/serverOwner/);
		expect(() => requireServerOwner(true, "o")).not.toThrow();
		expect(() => requireServerOwner(false, undefined)).not.toThrow();
	});
});

describe("identityAllowed", () => {
	it("allows anyone without a serverOwner", () => {
		expect(identityAllowed({ userId: "a" }, undefined)).toBe(true);
	});
	it("allows the owner or someone acting for them only", () => {
		expect(identityAllowed({ userId: "o" }, "o")).toBe(true);
		expect(identityAllowed({ userId: "h", actsFor: ["o"] }, "o")).toBe(true);
		expect(identityAllowed({ userId: "x" }, "o")).toBe(false);
		expect(identityAllowed({ userId: "x", actsFor: ["y"] }, "o")).toBe(false);
	});
});
