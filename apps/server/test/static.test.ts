import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWebRoot } from "../src/static.ts";

describe("defaultWebRoot", () => {
	const here = resolve("/opt/app/server");

	it("uses the web folder shipped beside main.js in an installed app", () => {
		const seen: string[] = [];
		const root = defaultWebRoot(here, (p) => (seen.push(p), true));
		expect(root).toBe(join(here, "web"));
		expect(seen).toEqual([join(here, "web", "index.html")]);
	});

	it("falls back to apps/web/dist in a source checkout", () => {
		expect(defaultWebRoot(here, () => false)).toBe(resolve(here, "../../web/dist"));
	});
});

describe("serveStatic compression", async () => {
	const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { createServer } = await import("node:http");
	const { brotliDecompressSync, gunzipSync } = await import("node:zlib");
	const { pickEncoding, serveStatic, buildCsp, isUnsafeRequestPath } = await import("../src/static.ts");
	const { createHash } = await import("node:crypto");

	const root = mkdtempSync(join(tmpdir(), "static-"));
	mkdirSync(join(root, "assets"));
	const big = "export const x = 'hello world';\n".repeat(400);
	const indexHtml = "<!doctype html><title>x</title><script>// inline\nwindow.x = 1;\n</script><script type=module src=\"./a.js\"></script>";
	writeFileSync(join(root, "index.html"), indexHtml);
	writeFileSync(join(root, "assets", "app.js"), big);
	writeFileSync(join(root, "assets", "font.woff2"), Buffer.alloc(4000, 7));
	const server = createServer((req, res) => void serveStatic(root, req, res).then((ok) => ok || res.writeHead(404).end()));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const get = (path: string, enc?: string) =>
		new Promise<{ headers: Record<string, unknown>; body: Buffer }>((resolveGet) => {
			import("node:http").then(({ get: httpGet }) =>
				httpGet({ host: "127.0.0.1", port, path, headers: enc === undefined ? {} : { "accept-encoding": enc } }, (res) => {
					const parts: Buffer[] = [];
					res.on("data", (c: Buffer) => parts.push(c));
					res.on("end", () => resolveGet({ headers: res.headers, body: Buffer.concat(parts) }));
				}),
			);
		});

	it("picks Brotli over gzip and ignores refused encodings", () => {
		expect(pickEncoding("gzip, deflate, br")).toBe("br");
		expect(pickEncoding("gzip")).toBe("gzip");
		expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
		expect(pickEncoding("identity")).toBeUndefined();
		expect(pickEncoding(undefined)).toBeUndefined();
	});

	it("sends Brotli that decodes to the original, much smaller", async () => {
		const r = await get("/assets/app.js", "gzip, br");
		expect(r.headers["content-encoding"]).toBe("br");
		expect(r.headers.vary).toBe("Accept-Encoding");
		expect(Number(r.headers["content-length"])).toBe(r.body.length);
		expect(r.body.length).toBeLessThan(big.length / 5);
		expect(brotliDecompressSync(r.body).toString()).toBe(big);
	});

	it("falls back to gzip, and to plain text for clients that accept nothing", async () => {
		const z = await get("/assets/app.js", "gzip");
		expect(z.headers["content-encoding"]).toBe("gzip");
		expect(gunzipSync(z.body).toString()).toBe(big);
		const plain = await get("/assets/app.js");
		expect(plain.headers["content-encoding"]).toBeUndefined();
		expect(plain.body.toString()).toBe(big);
	});

	it("rejects paths that could become a cross-origin base, and never serves index.html for them", async () => {
		const { request } = await import("node:http");
		// Raw request targets: http.get with a path of "//evil.com/rt/x" is sent as is.
		for (const path of ["//evil.com/rt/x", "/\\evil.com/rt/x", "/%5Cevil.com/rt/x", "/%5cevil.com/rt/x", "/%2F%2Fevil.com/rt/x", "/%2f%2fevil.com/rt/x", "///x"]) {
			const status = await new Promise<number>((done) => {
				const r = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
					res.resume();
					res.on("end", () => done(res.statusCode ?? 0));
				});
				r.end();
			});
			expect(status, path).toBe(400);
		}
		expect((await get("/invite/abc")).body.toString()).toContain("<title>x</title>");
	});

	it("isUnsafeRequestPath accepts ordinary targets", () => {
		expect(isUnsafeRequestPath("/")).toBe(false);
		expect(isUnsafeRequestPath("/plugins/team/rt/x?next=//a")).toBe(false);
		expect(isUnsafeRequestPath("//evil.com/rt/x")).toBe(true);
	});

	it("sends a CSP with the inline script hashes, and the other hardening headers, on HTML only", async () => {
		const html = (await get("/")).headers;
		const csp = String(html["content-security-policy"]);
		expect(csp).toBe(buildCsp(indexHtml));
		expect(csp).toContain(`script-src 'self' '${createHash("sha256").update("// inline\nwindow.x = 1;\n").digest("base64").replace(/^/, "sha256-")}'`);
		expect(html["x-content-type-options"]).toBe("nosniff");
		expect(html["referrer-policy"]).toBeDefined();
		expect((await get("/assets/app.js")).headers["content-security-policy"]).toBeUndefined();
		// Deep SPA routes get it too.
		expect((await get("/invite/abc")).headers["content-security-policy"]).toBe(csp);
	});

	it("builds the exact policy: self scripts, hashed inline, Turnstile, no foreign base or plugins", () => {
		const csp = buildCsp("<script>a()</script><script src='x.js'></script><script type=module src='y.js'></script>");
		const hash = `'sha256-${createHash("sha256").update("a()").digest("base64")}'`;
		expect(csp).toBe(
			[
				"default-src 'self'",
				`script-src 'self' ${hash} https://challenges.cloudflare.com`,
				"connect-src 'self' ws: wss: http: https:",
				"img-src 'self' data: blob: http: https:",
				"media-src 'self' data: blob:",
				"style-src 'self' 'unsafe-inline'",
				"font-src 'self' data:",
				"worker-src 'self' blob:",
				"frame-src 'self' http: https: https://challenges.cloudflare.com",
				"base-uri 'self'",
				"object-src 'none'",
				"form-action 'self'",
				"frame-ancestors 'self'",
			].join("; "),
		);
	});

	it("hashes every inline script of the real web index.html (built when present, source otherwise)", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		const dist = new URL("../../web/dist/index.html", import.meta.url);
		const file = existsSync(dist) ? dist : new URL("../../web/index.html", import.meta.url);
		const real = readFileSync(file, "utf8");
		const inline = [...real.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1] ?? ""));
		expect(inline.length).toBeGreaterThan(0);
		const csp = buildCsp(real);
		for (const m of inline) expect(csp).toContain(`'sha256-${createHash("sha256").update(m[2] ?? "").digest("base64")}'`);
	});

	it("leaves small files and already-compressed formats alone", async () => {
		expect((await get("/", "br")).headers["content-encoding"]).toBeUndefined();
		expect((await get("/assets/font.woff2", "br")).headers["content-encoding"]).toBeUndefined();
	});
});
