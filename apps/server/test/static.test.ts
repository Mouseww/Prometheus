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
	const { pickEncoding, serveStatic } = await import("../src/static.ts");

	const root = mkdtempSync(join(tmpdir(), "static-"));
	mkdirSync(join(root, "assets"));
	const big = "export const x = 'hello world';\n".repeat(400);
	writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title>");
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

	it("leaves small files and already-compressed formats alone", async () => {
		expect((await get("/", "br")).headers["content-encoding"]).toBeUndefined();
		expect((await get("/assets/font.woff2", "br")).headers["content-encoding"]).toBeUndefined();
	});
});
