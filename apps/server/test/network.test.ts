import { describe, expect, it } from "vitest";
import {
	accessFor,
	hashPassword,
	hostAllowed,
	hostnameOf,
	isForwarded,
	isLoopbackSocket,
	LoginLimiter,
	networkRequestAllowed,
	newSecret,
	normalizeHosts,
	signSession,
	verifyPassword,
	verifySession,
	checkPasswordRules,
} from "../src/network.ts";

describe("password hashing", () => {
	it("verifies the right password and rejects others", async () => {
		const stored = await hashPassword("correct horse");
		expect(stored.startsWith("scrypt$")).toBe(true);
		expect(await verifyPassword("correct horse", stored)).toBe(true);
		expect(await verifyPassword("correct horsf", stored)).toBe(false);
		expect(await verifyPassword("", stored)).toBe(false);
	});

	it("salts every hash and refuses malformed or missing records", async () => {
		expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
		for (const bad of [undefined, "", "plain", "scrypt$x$y$z", "scrypt$16384$$", "md5$16384$a$b"]) expect(await verifyPassword("anything", bad)).toBe(false);
	});

	it("enforces the length rules", () => {
		expect(() => checkPasswordRules("short")).toThrow(/至少/);
		expect(() => checkPasswordRules("x".repeat(201))).toThrow(/不能超过/);
		expect(() => checkPasswordRules(123)).toThrow();
		expect(checkPasswordRules("long enough")).toBe("long enough");
	});
});

describe("session tokens", () => {
	const secret = newSecret();

	it("accepts a fresh token and rejects expired, tampered and foreign ones", () => {
		const now = 1_000_000;
		const token = signSession(secret, now, 5000);
		expect(verifySession(secret, token, now + 1000)).toBe(true);
		expect(verifySession(secret, token, now + 6000)).toBe(false);
		expect(verifySession(newSecret(), token, now + 1000)).toBe(false);
		const [v, exp, nonce, sig] = token.split(".") as [string, string, string, string];
		expect(verifySession(secret, [v, String(Number(exp) + 99999), nonce, sig].join("."), now + 1000)).toBe(false);
		expect(verifySession(secret, `${token}x`, now + 1000)).toBe(false);
	});

	it("rejects garbage and a missing secret", () => {
		for (const t of ["", "v1", "v1.1.2", "v2.9999999999999.a.b", "a.b.c.d", "token"]) expect(verifySession(secret, t)).toBe(false);
		expect(verifySession(undefined, signSession(secret))).toBe(false);
	});
});

describe("LoginLimiter", () => {
	it("allows a few failures, then locks for a growing time, and a success clears it", () => {
		const l = new LoginLimiter(3, 1000, 10_000);
		const t = 0;
		l.fail("a", t);
		l.fail("a", t);
		expect(l.wait("a", t)).toBe(0);
		l.fail("a", t);
		expect(l.wait("a", t)).toBe(1);
		l.fail("a", t);
		expect(l.wait("a", t)).toBe(2);
		expect(l.wait("b", t)).toBe(0);
		expect(l.wait("a", t + 2500)).toBe(0);
		l.reset("a");
		expect(l.wait("a", t)).toBe(0);
	});

	it("forgets old failures after a quiet period", () => {
		const l = new LoginLimiter(2, 1000, 60_000, 10_000);
		l.fail("a", 0);
		l.fail("a", 0);
		expect(l.wait("a", 0)).toBe(1);
		l.fail("a", 20_000);
		expect(l.wait("a", 20_000)).toBe(0);
	});

	it("caps the lock time and can refund a pre-counted attempt", () => {
		const l = new LoginLimiter(1, 1000, 4000);
		for (let i = 0; i < 20; i++) l.fail("k", 0);
		expect(l.wait("k", 0)).toBe(4);
		const g = new LoginLimiter(2, 1000, 4000);
		g.fail("*", 0);
		g.fail("*", 0);
		expect(g.wait("*", 0)).toBe(1);
		g.refund("*", 0);
		expect(g.wait("*", 0)).toBe(0);
	});
});

describe("hostnameOf", () => {
	it("strips port, brackets, case and a trailing dot", () => {
		expect(hostnameOf("Example.COM:8080")).toBe("example.com");
		expect(hostnameOf("[::1]:7421")).toBe("::1");
		expect(hostnameOf("example.com.")).toBe("example.com");
		expect(hostnameOf(undefined)).toBe("");
	});
});

describe("normalizeHosts", () => {
	it("cleans entries, drops blanks and duplicates", () => {
		expect(normalizeHosts([" Agent.Example.com ", "agent.example.com", "", "*.corp.example.com", "nas:8443", "intranet"])).toEqual(["agent.example.com", "*.corp.example.com", "nas", "intranet"]);
	});

	it("rejects schemes, paths, wildcards-only, IPs and junk", () => {
		for (const bad of ["https://a.com", "a.com/x", "*", "a b.com", "-a.com", "a..com", "1.2.3.4", "user@a.com", "*.*.a.com"]) expect(() => normalizeHosts([bad])).toThrow(/域名格式不正确/);
		expect(() => normalizeHosts("a.com")).toThrow();
		expect(() => normalizeHosts([5])).toThrow();
		expect(() => normalizeHosts(Array.from({ length: 51 }, (_, i) => `h${i}.com`))).toThrow(/最多/);
	});
});

describe("hostAllowed", () => {
	const list = ["agent.example.com", "*.corp.example.com"];

	it("always allows IP literals and localhost, whatever the list says", () => {
		for (const h of ["192.168.1.5:7421", "10.0.0.2", "[::1]:7421", "[fe80::1]:7421", "localhost:7421"]) expect(hostAllowed(h, [])).toBe(true);
	});

	it("allows exact names and wildcard subdomains, not the apex of a wildcard", () => {
		expect(hostAllowed("agent.example.com", list)).toBe(true);
		expect(hostAllowed("AGENT.example.com:443", list)).toBe(true);
		expect(hostAllowed("a.corp.example.com", list)).toBe(true);
		expect(hostAllowed("x.y.corp.example.com", list)).toBe(true);
		expect(hostAllowed("corp.example.com", list)).toBe(false);
	});

	it("refuses everything else, including look-alikes and an empty Host", () => {
		for (const h of ["evil.com", "agent.example.com.evil.com", "notagent.example.com", "xcorp.example.com", "", undefined]) expect(hostAllowed(h, list)).toBe(false);
		expect(hostAllowed("agent.example.com", [])).toBe(false);
	});
});

describe("networkRequestAllowed", () => {
	const r = (host: string | undefined, origin?: string) => ({ headers: { host, origin } }) as never;
	const list = ["agent.example.com"];

	it("needs an allowed Host, then a matching or listed Origin", () => {
		expect(networkRequestAllowed(r("192.168.1.5:7421"), [])).toBe(true);
		expect(networkRequestAllowed(r("evil.com"), list)).toBe(false);
		expect(networkRequestAllowed(r("agent.example.com", "https://agent.example.com"), list)).toBe(true);
		expect(networkRequestAllowed(r("192.168.1.5:7421", "http://192.168.1.5:7421"), list)).toBe(true);
	});

	it("accepts a listed domain as Origin when the proxy does not forward Host, and the desktop app", () => {
		expect(networkRequestAllowed(r("127.0.0.1:7421", "https://agent.example.com"), list)).toBe(true);
		expect(networkRequestAllowed(r("192.168.1.5:7421", "http://tauri.localhost"), list)).toBe(true);
	});

	it("refuses foreign and malformed Origins, and a missing Host", () => {
		expect(networkRequestAllowed(r("192.168.1.5:7421", "https://evil.com"), list)).toBe(false);
		expect(networkRequestAllowed(r("192.168.1.5:7421", "not a url"), list)).toBe(false);
		expect(networkRequestAllowed(r(undefined), list)).toBe(false);
	});
});

describe("forwarding and loopback detection", () => {
	it("spots the headers a reverse proxy adds", () => {
		expect(isForwarded({ headers: {} })).toBe(false);
		for (const h of ["x-forwarded-for", "x-real-ip", "forwarded", "via", "x-forwarded-host", "x-forwarded-proto"]) expect(isForwarded({ headers: { [h]: "1.2.3.4" } })).toBe(true);
	});

	it("recognises loopback sockets including IPv4-mapped IPv6", () => {
		for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.9.9.9"]) expect(isLoopbackSocket(a)).toBe(true);
		for (const a of ["192.168.1.2", "::ffff:10.0.0.1", "", undefined]) expect(isLoopbackSocket(a)).toBe(false);
	});
});

describe("accessFor", () => {
	const base = { tokenSet: false, passwordSet: true, forwarded: false, loopbackSocket: true };

	it("lets a direct local connection in without a password", () => {
		expect(accessFor({ ...base, listener: "main" })).toEqual({ mode: "none", local: true });
	});

	it("makes the network listener ask for the password even from loopback, and refuses without one", () => {
		expect(accessFor({ ...base, listener: "network" })).toEqual({ mode: "password", local: false });
		expect(accessFor({ ...base, listener: "network", forwarded: true })).toEqual({ mode: "password", local: false });
		expect(accessFor({ ...base, listener: "network", passwordSet: false })).toEqual({ mode: "deny", local: false });
	});

	it("treats a proxied request on the main listener as a stranger", () => {
		expect(accessFor({ ...base, listener: "main", forwarded: true })).toEqual({ mode: "password", local: false });
		expect(accessFor({ ...base, listener: "main", forwarded: true, passwordSet: false })).toEqual({ mode: "deny", local: false });
	});

	it("keeps token deployments on tokens, and local only when direct", () => {
		expect(accessFor({ ...base, listener: "main", tokenSet: true })).toEqual({ mode: "token", local: true });
		expect(accessFor({ ...base, listener: "main", tokenSet: true, forwarded: true })).toEqual({ mode: "token", local: false });
		expect(accessFor({ ...base, listener: "main", tokenSet: true, loopbackSocket: false })).toEqual({ mode: "token", local: false });
	});
});
