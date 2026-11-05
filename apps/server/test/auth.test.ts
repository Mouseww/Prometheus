import { generateKeyPair, signJwt } from "@prometheus/core";
import { describe, expect, it } from "vitest";
import { hubTrustFromEnv, identityAllowed } from "../src/auth.ts";

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
