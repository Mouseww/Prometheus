/**
 * Bridges the panel's HTTP calls onto the same handlers the `plugin.call` RPC exposes.
 *
 * The panel lives in a sandboxed iframe with no WebSocket, so it needs a plain JSON endpoint.
 * Each registered method is mounted at `POST /rpc/<method>`; requests are already authenticated
 * by the host (the plugin routes sit behind the same auth as the rest of `/plugins/`).
 */
import { readJsonBody, sendHtml } from "./proxy/panel-html.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Handler = (params: Record<string, unknown>) => unknown;

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
	const body = JSON.stringify(value ?? null);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
	res.end(body);
}

/** Registers `POST /rpc/<method>` for every handler. */
export function rpcRoute(method: string): string {
	return `/rpc/${method}`;
}

export function rpcHandler(handler: Handler) {
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "只接受 POST" });
			return;
		}
		let params: Record<string, unknown>;
		try {
			const body = await readJsonBody(req);
			params = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : "请求体不合法" });
			return;
		}
		try {
			sendJson(res, 200, await handler(params));
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
	};
}

export { sendHtml };
