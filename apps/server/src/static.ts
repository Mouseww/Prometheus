import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
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

/** Serves the built web UI with SPA fallback; paths are normalised and confined to the root. */
export async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
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
	res.writeHead(200, {
		...SECURITY_HEADERS,
		"content-type": MIME[extname(file)] ?? "application/octet-stream",
		"content-length": info.size,
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	});
	if (req.method === "HEAD") {
		res.end();
		return true;
	}
	createReadStream(file).pipe(res);
	return true;
}
