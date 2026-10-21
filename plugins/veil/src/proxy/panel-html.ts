/**
 * Panel routes: one self-contained HTML page per panel, no bundler.
 *
 * Prometheus serves plugin panels in an `<iframe sandbox="allow-scripts allow-forms">`, so the
 * page cannot reach the host app's origin storage or cookies. It talks to the backend through
 * the same `plugin.call` RPC the rest of the UI uses, over the WebSocket the host already has.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PANEL_STYLE } from "./panel-style.ts";

export function sendHtml(res: ServerResponse, body: string): void {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		// Inline script/style only; no external origins, no framing others.
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
		"x-content-type-options": "nosniff",
	});
	res.end(body);
}

/** Reads a JSON request body with a byte cap. */
export function readJsonBody(req: IncomingMessage, limit = 512 * 1024): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

export function page(title: string, body: string, script: string): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PANEL_STYLE}</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>`;
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}
