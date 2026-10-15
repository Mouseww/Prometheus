import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isLoopbackAddress, originAllowed, parseCookies, tokensEqual } from "../src/security.ts";

const req = (host: string, origin?: string) => ({ headers: { host, origin } }) as unknown as IncomingMessage;
const open = { tokenRequired: false, extraOrigins: new Set<string>() };
const locked = { tokenRequired: true, extraOrigins: new Set(["https://ok.example"]) };

describe("security", () => {
	it("compares tokens", () => {
		expect(tokensEqual("abc", "abc")).toBe(true);
		expect(tokensEqual("abc", "abcd")).toBe(false);
	});

	it("detects loopback hosts", () => {
		expect(isLoopbackAddress("127.0.0.5")).toBe(true);
		expect(isLoopbackAddress("[::1]")).toBe(true);
		expect(isLoopbackAddress("10.0.0.1")).toBe(false);
	});

	it("blocks DNS rebinding when no token is set", () => {
		expect(originAllowed(req("evil.example:7420", "http://evil.example:7420"), open)).toBe(false);
		expect(originAllowed(req("127.0.0.1:7420", "http://localhost:5173"), open)).toBe(true);
	});

	it("blocks cross-site origins", () => {
		expect(originAllowed(req("127.0.0.1:7420", "https://evil.example"), open)).toBe(false);
		expect(originAllowed(req("srv.example", "https://evil.example"), locked)).toBe(false);
		expect(originAllowed(req("srv.example", "https://srv.example"), locked)).toBe(true);
		expect(originAllowed(req("srv.example", "https://ok.example"), locked)).toBe(true);
		expect(originAllowed(req("127.0.0.1:1234", "http://tauri.localhost"), locked)).toBe(true);
	});

	it("allows non-browser clients", () => {
		expect(originAllowed(req("srv.example"), locked)).toBe(true);
	});

	it("parses cookies", () => {
		expect(parseCookies("a=1; prometheus_token=x%20y")).toEqual({ a: "1", prometheus_token: "x y" });
	});
});
