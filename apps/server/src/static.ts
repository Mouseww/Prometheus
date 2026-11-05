import { existsSync, createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { extname, join, normalize, resolve, sep } from "node:path";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** The installer ships the web UI in `web/` beside main.js; a source checkout keeps it in apps/web/dist. */
export function defaultWebRoot(here: string, exists: (path: string) => boolean = existsSync): string {
	const bundled = join(here, "web");
	return exists(join(bundled, "index.html")) ? bundled : resolve(here, "../../web/dist");
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "SAMEORIGIN",
};

/**
 * A request path a browser could turn into a cross-origin base: `//host/...`, a backslash, or an encoded `//` or `\`.
 * Checked on the raw request target, because `new URL("//evil.com/x", base)` would otherwise read it as a host.
 */
export function isUnsafeRequestPath(rawTarget: string): boolean {
	const raw = rawTarget.split(/[?#]/, 1)[0] ?? "";
	if (raw.startsWith("//") || raw.includes("\\")) return true;
	const lower = raw.toLowerCase();
	if (lower.includes("%5c") || lower.includes("%2f%2f")) return true;
	try {
		const decoded = decodeURIComponent(raw);
		return decoded.startsWith("//") || decoded.includes("\\");
	} catch {
		return true;
	}
}

/** Same rules as the desktop shell's CSP in apps/desktop/src-tauri/tauri.conf.json, plus the Turnstile widget the hosted register page loads. */
const CSP_BASE = [
	"default-src 'self'",
	"connect-src 'self' ws: wss: http: https:",
	"img-src 'self' data: blob: http: https:",
	"media-src 'self' data: blob:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self' data:",
	"worker-src 'self' blob:",
	"frame-src 'self' http: https:",
	"base-uri 'self'",
	"object-src 'none'",
	"form-action 'self'",
	"frame-ancestors 'self'",
];

/** SHA-256 source expressions for every inline `<script>` (no `src`) in the page. */
export function inlineScriptHashes(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
		if (/\bsrc\s*=/i.test(m[1] ?? "")) continue;
		out.push(`'sha256-${createHash("sha256").update(m[2] ?? "", "utf8").digest("base64")}'`);
	}
	return out;
}

/** The CSP for the HTML shell: scripts from this origin, the page's own inline scripts by hash, and Turnstile. */
export function buildCsp(html: string): string {
	const scripts = ["'self'", ...inlineScriptHashes(html), "https://challenges.cloudflare.com"].join(" ");
	return [CSP_BASE[0], `script-src ${scripts}`, ...CSP_BASE.slice(1).map((d) => (d.startsWith("frame-src") ? `${d} https://challenges.cloudflare.com` : d))].join("; ");
}

/** The CSP per HTML file, recomputed when the file changes. */
const cspCache = new Map<string, { key: string; csp: string }>();

async function cspFor(file: string, mtimeMs: number, size: number): Promise<string> {
	const key = `${mtimeMs}|${size}`;
	const hit = cspCache.get(file);
	if (hit?.key === key) return hit.csp;
	const csp = buildCsp(await readFile(file, "utf8"));
	cspCache.set(file, { key, csp });
	return csp;
}

/** Text formats shrink to a third or less; fonts, images and the like are already compressed. */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest"]);
const MIN_COMPRESS = 1024;
type Encoding = "br" | "gzip";

/** Compressed copies by file, kept until the file changes: each is made once, not per request. */
const packed = new Map<string, Promise<Buffer>>();
const PACKED_MAX = 200;

/** The best encoding the browser accepts (Brotli, then gzip), or undefined for plain. */
export function pickEncoding(accept: string | string[] | undefined): Encoding | undefined {
	const header = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
	const offered = new Set(
		header
			.split(",")
			.map((p) => p.trim().toLowerCase())
			.filter((p) => !/;\s*q=0(\.0*)?$/.test(p))
			.map((p) => p.split(";")[0]),
	);
	if (offered.has("br")) return "br";
	if (offered.has("gzip")) return "gzip";
	return undefined;
}

function compressed(file: string, mtimeMs: number, size: number, encoding: Encoding): Promise<Buffer> {
	const key = `${encoding}|${file}|${mtimeMs}|${size}`;
	let hit = packed.get(key);
	if (!hit) {
		if (packed.size >= PACKED_MAX) packed.delete(packed.keys().next().value as string);
		hit = readFile(file).then((raw) => (encoding === "br" ? brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 8, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : gz(raw, { level: 9 })));
		hit.catch(() => packed.delete(key));
		packed.set(key, hit);
	}
	return hit;
}

/** Serves the built web UI with SPA fallback; paths are normalised and confined to the root. */
export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	if (isUnsafeRequestPath(req.url ?? "/")) {
		res.writeHead(400, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
		res.end(req.method === "HEAD" ? undefined : "Bad request path");
		return true;
	}
	const base = resolve(root);
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
	} catch {
		return false;
	}
	if (pathname.includes("\0")) return false;
	let file = resolve(join(base, normalize(pathname)));
	if (file !== base && !file.startsWith(base + sep)) return false;

	let info = await stat(file).catch(() => undefined);
	if (info?.isDirectory()) {
		file = join(file, "index.html");
		info = await stat(file).catch(() => undefined);
	}
	if (!info?.isFile()) {
		if (extname(pathname)) return false;
		file = join(base, "index.html");
		info = await stat(file).catch(() => undefined);
		if (!info?.isFile()) return false;
	}

	const immutable = file.includes(`${sep}assets${sep}`);
	const isHtml = extname(file) === ".html";
	let csp: string | undefined;
	if (isHtml) {
		try {
			csp = await cspFor(file, info.mtimeMs, info.size);
		} catch {
			return false;
		}
	}
	const headers = {
		...SECURITY_HEADERS,
		...(csp ? { "content-security-policy": csp } : {}),
		"content-type": MIME[extname(file)] ?? "application/octet-stream",
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	};
	const compressible = COMPRESSIBLE.has(extname(file)) && info.size >= MIN_COMPRESS;
	const encoding = compressible ? pickEncoding(req.headers["accept-encoding"]) : undefined;
	if (encoding) {
		let body: Buffer;
		try {
			body = await compressed(file, info.mtimeMs, info.size, encoding);
		} catch {
			return false;
		}
		res.writeHead(200, { ...headers, "content-encoding": encoding, vary: "Accept-Encoding", "content-length": body.length });
		res.end(req.method === "HEAD" ? undefined : body);
		return true;
	}
	res.writeHead(200, { ...headers, ...(compressible ? { vary: "Accept-Encoding" } : {}), "content-length": info.size });
	if (req.method === "HEAD") {
		res.end();
		return true;
	}
	createReadStream(file).pipe(res);
	return true;
}
