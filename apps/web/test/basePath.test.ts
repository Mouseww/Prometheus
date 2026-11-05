import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { basePathFromPathname, isSafePrefix, PROXY_PREFIX_PATTERN, withBase, wsUrlFor } from "../src/lib/basePath.ts";
import { targetFromUrl } from "../src/lib/target.ts";
import { createHubApi, type KeyValueStore } from "../src/team/hubApi.ts";

describe("basePathFromPathname", () => {
	it("is empty at the site root and for ordinary deep routes", () => {
		expect(basePathFromPathname("/")).toBe("");
		expect(basePathFromPathname("/invite/abc")).toBe("");
		expect(basePathFromPathname("/verify-email")).toBe("");
		expect(basePathFromPathname("/plugins/team")).toBe("");
	});

	it("takes everything up to the tenant proxy marker", () => {
		expect(basePathFromPathname("/plugins/team/rt/")).toBe("/plugins/team/rt");
		expect(basePathFromPathname("/plugins/team/rt")).toBe("/plugins/team/rt");
		expect(basePathFromPathname("/plugins/team/rt/index.html")).toBe("/plugins/team/rt");
		expect(basePathFromPathname("/hub/plugins/team/rt/some/deep/route")).toBe("/hub/plugins/team/rt");
	});

	it("does not mistake a path that merely contains the letters rt", () => {
		expect(basePathFromPathname("/art/")).toBe("");
		expect(basePathFromPathname("/plugins/team/rtx/")).toBe("");
	});
});

const ORIGIN = "https://hub.test";
const HOSTILE = ["//evil.com/rt/x", "/\\evil.com/rt/x", "/%2F%2Fevil.com/rt/x", "///evil.com/rt/", "/a/../rt/x", "/a/%2e%2e/rt/x", "/a:b/rt/x", "/a\\b/rt/x", "//evil.com/rt"];

describe("basePathFromPathname hostile prefixes", () => {
	it("falls back to the root for anything that could leave the origin", () => {
		for (const p of HOSTILE) expect(basePathFromPathname(p, ORIGIN), p).toBe("");
	});

	it("keeps valid prefixes and ordinary routes", () => {
		expect(basePathFromPathname("/a/rt/x", ORIGIN)).toBe("/a/rt");
		expect(basePathFromPathname("/plugins/team/rt/", ORIGIN)).toBe("/plugins/team/rt");
		expect(basePathFromPathname("/", ORIGIN)).toBe("");
		expect(basePathFromPathname("/invite/0123456789abcdef", ORIGIN)).toBe("");
		expect(basePathFromPathname("/a/b/c/d/e/verify-email", ORIGIN)).toBe("");
	});

	it("isSafePrefix resolves against the origin", () => {
		expect(isSafePrefix("/a/rt", ORIGIN)).toBe(true);
		expect(isSafePrefix("//evil.com/rt", ORIGIN)).toBe(false);
		expect(isSafePrefix("/a/rt", "null")).toBe(false);
	});
});

describe("withBase", () => {
	it("prefixes absolute paths and leaves the root alone", () => {
		expect(withBase("/api/health", "")).toBe("/api/health");
		expect(withBase("/api/health", "/plugins/team/rt")).toBe("/plugins/team/rt/api/health");
		expect(withBase("/ws", "/plugins/team/rt")).toBe("/plugins/team/rt/ws");
	});

	it("keeps relative and absolute URLs as they are", () => {
		expect(withBase("assets/a.js", "/p")).toBe("assets/a.js");
		expect(withBase("https://x.test/a", "/p")).toBe("https://x.test/a");
	});
});

describe("wsUrlFor", () => {
	it("keeps the prefix and picks the scheme from the page protocol", () => {
		expect(wsUrlFor("/ws", { protocol: "https:", host: "hub.test", pathname: "/plugins/team/rt/" })).toBe("wss://hub.test/plugins/team/rt/ws");
		expect(wsUrlFor("/ws", { protocol: "http:", host: "localhost:7420", pathname: "/" })).toBe("ws://localhost:7420/ws");
		expect(wsUrlFor("/plugins/team/ws", { protocol: "http:", host: "h", pathname: "/invite/x" })).toBe("ws://h/plugins/team/ws");
	});
});

describe("targetFromUrl", () => {
	it("is unchanged without a prefix", () => {
		const t = targetFromUrl("http://127.0.0.1:7420", "tok");
		expect(t).toEqual({ wsUrl: "ws://127.0.0.1:7420/ws", httpBase: "http://127.0.0.1:7420", token: "tok", label: "127.0.0.1:7420" });
	});

	it("puts the prefix on both the socket and the HTTP base", () => {
		const t = targetFromUrl("https://hub.test", undefined, "/plugins/team/rt");
		expect(t.wsUrl).toBe("wss://hub.test/plugins/team/rt/ws");
		expect(t.httpBase).toBe("https://hub.test/plugins/team/rt");
	});
});

describe("index.html base rule", () => {
	it("uses the same pattern as the runtime helper", () => {
		const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
		const start = html.indexOf("var m = /");
		const end = html.indexOf("/.exec(location.pathname)");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const literal = html.slice(start + "var m = /".length, end);
		// The inline script holds the pattern as a regex literal, the helper as a string: equal once unescaped.
		expect(literal.replace(/\\\//g, "/")).toBe(PROXY_PREFIX_PATTERN);
	});

	it("picks the same base as the runtime helper for every path, hostile ones included", () => {
		const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
		const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
		const paths = [...HOSTILE, "/", "/invite/abc", "/a/rt/x", "/a/rt", "/plugins/team/rt/", "/hub/plugins/team/rt/deep/route", "/art/", "/plugins/team/rtx/"];
		for (const pathname of paths) {
			let href = "";
			const sandbox = {
				location: { pathname, origin: ORIGIN },
				URL,
				document: {
					createElement: () => ({
						set href(v: string) {
							href = v;
						},
					}),
					head: { appendChild: () => undefined },
				},
			};
			runInNewContext(script, sandbox);
			expect(href, pathname).toBe(`${basePathFromPathname(pathname, ORIGIN)}/`);
		}
	});
});

describe("hub API under a prefix", () => {
	const mem = (): KeyValueStore => {
		const m = new Map<string, string>();
		return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
	};

	it("sends requests below an explicit base URL", async () => {
		const seen: string[] = [];
		const api = createHubApi({
			baseUrl: "/plugins/team/rt/plugins/team",
			session: mem(),
			local: mem(),
			fetch: (async (url: string) => {
				seen.push(String(url));
				return new Response(JSON.stringify({ ok: true, data: { version: "1" } }), { status: 200 });
			}) as unknown as typeof fetch,
		});
		await api.meta();
		expect(seen).toEqual(["/plugins/team/rt/plugins/team/api/meta"]);
	});

	it("builds the workbench address with the stored access token, and none when signed out", async () => {
		const session = mem();
		const api = createHubApi({ session, local: mem() });
		expect(await api.workbenchUrl()).toBeUndefined();
		session.setItem("prometheus.team.access", "a.b.c");
		expect(await api.workbenchUrl()).toBe("/plugins/team/rt/?token=a.b.c");
	});
});
