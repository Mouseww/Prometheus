import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitFields } from "../src/index.ts";
import { assertSafeUrl, fill } from "../src/http.ts";
import { pkcePair, pollDevice, refreshToken } from "../src/oauth.ts";
import { dialectOf, isReadOnlySql } from "../src/providers/database.ts";
import { htmlToText } from "../src/providers/microsoft.ts";
import { adf, flattenAdf } from "../src/providers/atlassian.ts";
import { providers } from "../src/providers/index.ts";
import { createService, decide, renderResult } from "../src/service.ts";
import type { Operation } from "../src/types.ts";
import { openVault } from "../src/vault.ts";

afterEach(() => vi.restoreAllMocks());

const tmp = () => mkdtemp(join(tmpdir(), "connectors-"));

function mockFetch(handler: (url: string, init: RequestInit) => unknown, status = 200) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const body = handler(String(input), init ?? {});
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	});
}

describe("vault", () => {
	it("stores secrets encrypted and round-trips them", async () => {
		const dir = await tmp();
		const vault = await openVault(dir);
		const rec = await vault.add({ provider: "github", label: "me", authKind: "token", policy: "confirm", config: {}, secrets: { token: "ghp_SUPERSECRET", values: {} } });
		const onDisk = await readFile(join(dir, "vault.json"), "utf8");
		expect(onDisk).not.toContain("ghp_SUPERSECRET");
		expect((await vault.secrets(rec)).token).toBe("ghp_SUPERSECRET");
		// A second open reads the same key file and can decrypt.
		const again = await openVault(dir);
		expect((await again.secrets((await again.get(rec.id))!)).token).toBe("ghp_SUPERSECRET");
	});

	it("rejects tampered ciphertext", async () => {
		const vault = await openVault(await tmp());
		const rec = await vault.add({ provider: "github", label: "x", authKind: "token", policy: "allow", config: {}, secrets: { token: "t", values: {} } });
		const raw = Buffer.from(rec.secret, "base64");
		raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
		await expect(vault.secrets({ ...rec, secret: raw.toString("base64") })).rejects.toThrow();
	});

	it("removes connections", async () => {
		const vault = await openVault(await tmp());
		const rec = await vault.add({ provider: "github", label: "x", authKind: "token", policy: "allow", config: {}, secrets: { values: {} } });
		expect(await vault.remove(rec.id)).toBe(true);
		expect(await vault.remove(rec.id)).toBe(false);
	});
});

describe("policy", () => {
	it("gates writes by policy and never gates reads", () => {
		expect(decide("read-only", "read")).toBe("allow");
		expect(decide("read-only", "write")).toBe("deny");
		expect(decide("confirm", "write")).toBe("ask");
		expect(decide("allow", "write")).toBe("allow");
	});

	it("truncates oversized results", () => {
		const out = renderResult("x".repeat(100), 10);
		expect(out.startsWith("xxxxxxxxxx")).toBe(true);
		expect(out).toContain("已截断");
	});
});

describe("sql guard", () => {
	it("accepts plain reads", () => {
		for (const q of ["SELECT * FROM t", "  select 1;", "WITH a AS (SELECT 1) SELECT * FROM a", "EXPLAIN SELECT 1", "PRAGMA table_info(t)"]) expect(isReadOnlySql(q), q).toBe(true);
	});

	it("rejects writes, stacked statements and write CTEs", () => {
		for (const q of ["DELETE FROM t", "SELECT 1; DROP TABLE t", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "SELECT * INTO x FROM t", "EXPLAIN ANALYZE DELETE FROM t", "PRAGMA journal_mode = off", "", "-- hi\nUPDATE t SET a=1"]) expect(isReadOnlySql(q), q).toBe(false);
	});

	it("is not fooled by literals or comments", () => {
		expect(isReadOnlySql("SELECT 'a; DROP TABLE t' AS s")).toBe(true);
		expect(isReadOnlySql("SELECT 1 /* delete */")).toBe(true);
		expect(isReadOnlySql("SELECT 1 -- ; drop")).toBe(true);
	});

	it("detects dialects", () => {
		expect(dialectOf("postgres://u@h/db")).toBe("postgres");
		expect(dialectOf("sqlite:/tmp/a.db")).toBe("sqlite");
		expect(() => dialectOf("mysql://x")).toThrow();
	});
});

describe("sqlite end to end", () => {
	it("runs reads, blocks writes through query, and writes through execute", async () => {
		const file = join(await tmp(), "t.db");
		const { DatabaseSync } = await import("node:sqlite");
		const seed = new DatabaseSync(file);
		seed.exec("CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES (1,'ann'),(2,'bob');");
		seed.close();

		const db = providers.find((p) => p.id === "database")!;
		const op = (n: string) => db.operations.find((o) => o.name === n) as Operation;
		const ctx = { credentials: { config: {}, secrets: { connection: `sqlite:${file}` } }, policy: "allow" as const };

		expect(await db.test(ctx)).toBe("sqlite");
		expect(await op("schema").run({}, ctx)).toEqual({ users: ["id INTEGER", "name TEXT"] });
		const r = (await op("query").run({ sql: "SELECT name FROM users WHERE id = ?", params: [2] }, ctx)) as { rows: unknown[][] };
		expect(r.rows).toEqual([["bob"]]);
		await expect(op("query").run({ sql: "DELETE FROM users" }, ctx)).rejects.toThrow("只读");
		const w = (await op("execute").run({ sql: "DELETE FROM users WHERE id = ?", params: [1] }, ctx)) as { affected: number };
		expect(w.affected).toBe(1);
	});
});

describe("service", () => {
	async function setup() {
		const vault = await openVault(await tmp());
		const service = createService(vault);
		const rec = await vault.add({ provider: "github", label: "gh", authKind: "token", policy: "confirm", config: {}, secrets: { token: "tok", values: {} } });
		return { vault, service, rec };
	}

	it("sends the stored token and validates params", async () => {
		const { service, rec } = await setup();
		const spy = mockFetch(() => [{ full_name: "a/b", private: false, description: null, html_url: "u" }]);
		const out = await service.call({ connection: rec.id, operation: "list_repos", params: {} });
		expect(out).toEqual([{ name: "a/b", private: false, description: null, url: "u" }]);
		expect((spy.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer tok");
		await expect(service.call({ connection: rec.id, operation: "get_issue", params: { repo: "bad repo", number: 1 } })).rejects.toThrow("参数无效");
		await expect(service.call({ connection: rec.id, operation: "nope", params: {} })).rejects.toThrow("没有操作");
	});

	it("asks before writes, and refuses when nobody can answer", async () => {
		const { service, rec } = await setup();
		const spy = mockFetch(() => ({ number: 1, title: "t", state: "open", html_url: "u" }));
		const params = { repo: "a/b", title: "t" };
		await expect(service.call({ connection: rec.id, operation: "create_issue", params })).rejects.toThrow("没有可交互");
		await expect(service.call({ connection: rec.id, operation: "create_issue", params, confirm: async () => false })).rejects.toThrow("拒绝");
		expect(spy).not.toHaveBeenCalled();
		await service.call({ connection: rec.id, operation: "create_issue", params, confirm: async () => true });
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("blocks writes on read-only connections without asking", async () => {
		const { service, vault, rec } = await setup();
		await vault.patch(rec.id, { policy: "read-only" });
		const confirm = vi.fn(async () => true);
		await expect(service.call({ connection: rec.id, operation: "create_issue", params: { repo: "a/b", title: "t" }, confirm })).rejects.toThrow("只读");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("refreshes an expired OAuth token once for concurrent calls", async () => {
		const vault = await openVault(await tmp());
		const service = createService(vault);
		const rec = await vault.add({
			provider: "microsoft",
			label: "ms",
			authKind: "oauth-device",
			policy: "allow",
			config: { tenant: "organizations" },
			expiresAt: Date.now() - 1000,
			secrets: { token: "old", refreshToken: "r1", clientId: "cid", values: {} },
		});
		const seen: string[] = [];
		mockFetch((url, init) => {
			if (url.includes("/token")) return { access_token: "new", refresh_token: "r2", expires_in: 3600 };
			seen.push((init.headers as Record<string, string>).authorization ?? "");
			return { value: [] };
		});
		await Promise.all([service.call({ connection: rec.id, operation: "teams_list", params: {} }), service.call({ connection: rec.id, operation: "teams_list", params: {} })]);
		expect(seen).toEqual(["Bearer new", "Bearer new"]);
		expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes("/token"))).toHaveLength(1);
		const stored = await vault.secrets((await vault.get(rec.id))!);
		expect(stored.refreshToken).toBe("r2");
	});
});

describe("oauth", () => {
	it("creates a valid S256 PKCE pair", () => {
		const { verifier, challenge } = pkcePair();
		expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
	});

	const device = { kind: "oauth-device", deviceUrl: "https://x/d", tokenUrl: "https://x/t", scopes: [] } as const;

	it("treats authorization_pending as pending, including on HTTP 400", async () => {
		mockFetch(() => ({ error: "authorization_pending" }), 400);
		expect(await pollDevice(device, {}, "c", "dc")).toEqual({ status: "pending" });
	});

	it("fails on denial and returns tokens on success", async () => {
		mockFetch(() => ({ error: "access_denied", error_description: "no" }));
		await expect(pollDevice(device, {}, "c", "dc")).rejects.toThrow("no");
		vi.restoreAllMocks();
		mockFetch(() => ({ access_token: "a", expires_in: 60 }));
		const r = await pollDevice(device, {}, "c", "dc");
		expect(r.status === "done" && r.token.accessToken).toBe("a");
	});

	it("keeps the old refresh token when none is returned", async () => {
		mockFetch(() => ({ access_token: "a2" }));
		const r = await refreshToken(device, {}, { clientId: "c", refreshToken: "keep" });
		expect(r.refreshToken).toBe("keep");
	});
});

describe("http safety", () => {
	it("refuses plain http to remote hosts and unsafe placeholders", () => {
		expect(() => assertSafeUrl("http://evil.example.com")).toThrow();
		expect(() => assertSafeUrl("http://localhost:1234")).not.toThrow();
		expect(() => fill("https://{tenant}.x", { tenant: "a/b" })).toThrow();
		expect(fill("https://{tenant}.x", { tenant: "contoso.com" })).toBe("https://contoso.com.x");
	});

	it("does not follow redirects with credentials", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 302, headers: { location: "https://evil.example" } }));
		const { request } = await import("../src/http.ts");
		await expect(request("https://api.example.com/x")).rejects.toThrow("拒绝跟随");
	});
});

describe("helpers", () => {
	it("splits secret, token and plain fields and enforces required ones", () => {
		const specs = [
			{ key: "site", label: "站点", required: true },
			{ key: "token", label: "t", secret: true, required: true },
			{ key: "pw", label: "p", secret: true },
		];
		const r = splitFields(specs, { site: "a", token: "T", pw: "P", junk: "ignored" });
		expect(r.config).toEqual({ site: "a" });
		expect(r.secrets).toEqual({ token: "T", values: { pw: "P" } });
		expect(() => splitFields(specs, { site: "a" })).toThrow("请填写");
	});

	it("converts ADF and HTML to text", () => {
		expect(flattenAdf(adf("hello\n\nworld"))).toBe("hello\n\nworld");
		expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><style>x{}</style>")).toBe("Hi there");
	});
});
