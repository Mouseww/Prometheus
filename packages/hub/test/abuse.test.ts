import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit.ts";
import { createAbuseGuard, REGISTER_PER_IP_PER_HOUR, REGISTER_PER_SUBNET_PER_DAY, subnetKey } from "../src/services/abuse.ts";
import { silentLog } from "../src/log.ts";
import type { AuditService } from "../src/services/audit.ts";
import { PASSWORD, type TestHub } from "./hub-helpers.ts";
import { type PublicTestHub, startPublicHub } from "./p-helpers.ts";

describe("subnetKey", () => {
	it("maps IPv4 to /24 and IPv6 to /48", () => {
		expect(subnetKey("203.0.113.77")).toBe("203.0.113.0/24");
		expect(subnetKey("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
		expect(subnetKey("2001:db8:abcd:1::5")).toBe("2001:db8:abcd::/48");
		expect(subnetKey("2001:db8:abcd:ffff:1:2:3:4")).toBe("2001:db8:abcd::/48");
		expect(subnetKey("2001:0db8:abcd::1")).toBe("2001:db8:abcd::/48");
		expect(subnetKey("not-an-ip")).toBe("not-an-ip");
	});
});

describe("registration rate limits", () => {
	const guard = (): ReturnType<typeof createAbuseGuard> =>
		createAbuseGuard({ db: undefined as never, log: silentLog, now: Date.now }, new RateLimiter(), undefined as unknown as AuditService);

	it("allows 5 per IP per hour, then 429", () => {
		const g = guard();
		for (let i = 0; i < REGISTER_PER_IP_PER_HOUR; i++) g.checkRegistrationRate("203.0.113.9");
		expect(() => g.checkRegistrationRate("203.0.113.9")).toThrow(expect.objectContaining({ status: 429 }));
		// Another host in the same /24 is not blocked by the per-IP rule.
		expect(() => g.checkRegistrationRate("203.0.113.10")).not.toThrow();
	});

	it("allows 50 per /24 per day across different IPs, then 429; other subnets are unaffected", () => {
		const g = guard();
		for (let i = 0; i < REGISTER_PER_SUBNET_PER_DAY; i++) g.checkRegistrationRate(`203.0.113.${i + 1}`);
		expect(() => g.checkRegistrationRate("203.0.113.200")).toThrow(expect.objectContaining({ status: 429 }));
		expect(() => g.checkRegistrationRate("203.0.114.1")).not.toThrow();
	});

	it("applies the same subnet cap to an IPv6 /48", () => {
		const g = guard();
		for (let i = 0; i < REGISTER_PER_SUBNET_PER_DAY; i++) g.checkRegistrationRate(`2001:db8:1:${i.toString(16)}::1`);
		expect(() => g.checkRegistrationRate("2001:db8:1:ffff::1")).toThrow(expect.objectContaining({ status: 429 }));
		expect(() => g.checkRegistrationRate("2001:db8:2::1")).not.toThrow();
	});
});

describe("abuse guards over HTTP (public mode)", () => {
	const hubs: TestHub[] = [];
	const start = async (): Promise<PublicTestHub> => {
		const t = await startPublicHub();
		hubs.push(t);
		return t;
	};
	afterEach(async () => {
		await Promise.all(hubs.splice(0).map((t) => t.stop()));
	});
	const reg = (t: TestHub, email: string, ip: string) => t.api("POST", "/api/auth/register", { body: { email, password: PASSWORD, displayName: "U" }, ip });

	it("rejects the 6th registration from one IP within the hour", async () => {
		const t = await start();
		for (let i = 0; i < 5; i++) expect((await reg(t, `u${i}@example.com`, "203.0.113.50")).status).toBe(201);
		const sixth = await reg(t, "u5@example.com", "203.0.113.50");
		expect(sixth.status).toBe(429);
		expect(sixth.headers.get("retry-after")).toBeTruthy();
		expect((await reg(t, "u5@example.com", "203.0.113.51")).status).toBe(201);
	});

	it("blocks built-in disposable domains", async () => {
		const t = await start();
		const r = await reg(t, "x@mailinator.com", "203.0.113.60");
		expect(r.status).toBe(403);
		expect(r.code).toBe("disposableEmail");
	});

	it("operator CRUD extends the blocklist, case-insensitively, and removal re-allows the domain", async () => {
		const t = await start();
		const tok = t.operator.token;
		expect((await reg(t, "a@throwaway.test", "203.0.113.70")).status).toBe(201);
		const add = await t.api("POST", "/api/admin/disposable-domains", { token: tok, body: { domain: "@Burner.Example" } });
		expect(add.status).toBe(201);
		expect(add.data.domain).toBe("burner.example");
		expect((await t.api("POST", "/api/admin/disposable-domains", { token: tok, body: { domain: "burner.example" } })).code).toBe("domainExists");
		expect((await t.api("GET", "/api/admin/disposable-domains", { token: tok })).data.map((d: { domain: string }) => d.domain)).toEqual(["burner.example"]);
		const blocked = await reg(t, "b@BURNER.example", "203.0.113.71");
		expect(blocked.code).toBe("disposableEmail");
		expect((await t.api("DELETE", "/api/admin/disposable-domains/burner.example", { token: tok })).status).toBe(200);
		expect((await t.api("DELETE", "/api/admin/disposable-domains/burner.example", { token: tok })).status).toBe(404);
		expect((await reg(t, "b@burner.example", "203.0.113.72")).status).toBe(201);
	});

	it("only the operator manages the blocklist", async () => {
		const t = await start();
		const u = await t.registerVerified("plain@example.com");
		expect((await t.api("GET", "/api/admin/disposable-domains", { token: u.token })).status).toBe(403);
		expect((await t.api("POST", "/api/admin/disposable-domains", { token: u.token, body: { domain: "x.example" } })).status).toBe(403);
	});
});
