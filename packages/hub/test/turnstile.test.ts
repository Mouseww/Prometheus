import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { silentLog } from "../src/log.ts";
import { resolveTurnstile, TURNSTILE_VERIFY_URL, verifyTurnstile } from "../src/services/turnstile.ts";
import { PASSWORD, type TestHub } from "./hub-helpers.ts";
import { startPublicHub } from "./p-helpers.ts";

interface FakeSiteverify {
	url: string;
	requests: URLSearchParams[];
	close(): Promise<void>;
}

/** A fake Cloudflare siteverify: token "good" succeeds, anything else fails. */
async function fakeSiteverify(status = 200): Promise<FakeSiteverify> {
	const requests: URLSearchParams[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
			requests.push(form);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ success: form.get("response") === "good" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/siteverify`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((fn) => fn()));
});

describe("turnstile verification", () => {
	it("is disabled without a secret and defaults to the Cloudflare URL", () => {
		expect(resolveTurnstile({})).toBeUndefined();
		expect(resolveTurnstile({ HUB_TURNSTILE_SECRET: "s" })).toEqual({ secret: "s", siteKey: undefined, verifyUrl: TURNSTILE_VERIFY_URL });
		expect(TURNSTILE_VERIFY_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
	});

	it("posts secret, response and remoteip as a form and honours success", async () => {
		const fake = await fakeSiteverify();
		closers.push(fake.close);
		const cfg = { secret: "sek", siteKey: undefined, verifyUrl: fake.url };
		expect(await verifyTurnstile(cfg, "good", "203.0.113.5", silentLog)).toBe(true);
		expect(await verifyTurnstile(cfg, "bad", undefined, silentLog)).toBe(false);
		expect(fake.requests[0]?.get("secret")).toBe("sek");
		expect(fake.requests[0]?.get("response")).toBe("good");
		expect(fake.requests[0]?.get("remoteip")).toBe("203.0.113.5");
		expect(fake.requests[1]?.has("remoteip")).toBe(false);
	});

	it("fails closed on HTTP errors and unreachable servers", async () => {
		const broken = await fakeSiteverify(500);
		closers.push(broken.close);
		expect(await verifyTurnstile({ secret: "s", siteKey: undefined, verifyUrl: broken.url }, "good", undefined, silentLog)).toBe(false);
		expect(await verifyTurnstile({ secret: "s", siteKey: undefined, verifyUrl: "http://127.0.0.1:1/x" }, "good", undefined, silentLog)).toBe(false);
	});
});

describe("registration with Turnstile enabled", () => {
	const startWith = async (): Promise<{ t: TestHub; fake: FakeSiteverify }> => {
		const fake = await fakeSiteverify();
		closers.push(fake.close);
		const t = await startPublicHub({ env: { HUB_TURNSTILE_SECRET: "sek", HUB_TURNSTILE_SITE_KEY: "pub", HUB_TURNSTILE_VERIFY_URL: fake.url } });
		closers.push(() => t.stop());
		return { t, fake };
	};
	const reg = (t: TestHub, email: string, turnstileToken?: string) =>
		t.api("POST", "/api/auth/register", { body: { email, password: PASSWORD, displayName: "U", ...(turnstileToken ? { turnstileToken } : {}) } });

	it("requires a token, rejects a failed one and accepts a good one", async () => {
		const { t, fake } = await startWith();
		const missing = await reg(t, "a@example.com");
		expect(missing.status).toBe(400);
		expect(missing.code).toBe("turnstileRequired");
		const bad = await reg(t, "a@example.com", "bad");
		expect(bad.status).toBe(403);
		expect(bad.code).toBe("turnstileFailed");
		const ok = await reg(t, "a@example.com", "good");
		expect(ok.status).toBe(201);
		expect(fake.requests.map((r) => r.get("response"))).toEqual(["bad", "good"]);
	});

	it("does not call Turnstile for invitation based registration", async () => {
		const { t, fake } = await startWith();
		const before = fake.requests.length;
		const r = await t.api("POST", "/api/auth/register", { body: { email: "z@example.com", password: PASSWORD, displayName: "Z", inviteToken: "bogus" } });
		expect(r.code).toBe("invalidInvite");
		expect(fake.requests.length).toBe(before);
	});
});
