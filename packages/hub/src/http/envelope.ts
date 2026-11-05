import type { ServerResponse } from "node:http";
import { HubError } from "../errors.ts";
import { LOG_PREFIX, type HubLog } from "../log.ts";

export interface SuccessEnvelope<T = unknown> {
	ok: true;
	data: T;
}
export interface ErrorEnvelope {
	ok: false;
	error: { code: string; message: string };
}

export function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	if (res.headersSent) return;
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
		...headers,
	});
	res.end(payload);
}

export const writeOk = (res: ServerResponse, data: unknown, status = 200, headers?: Record<string, string>): void => writeJson(res, status, { ok: true, data }, headers);

export function writeError(res: ServerResponse, status: number, code: string, message: string, headers?: Record<string, string>): void {
	writeJson(res, status, { ok: false, error: { code, message } } satisfies ErrorEnvelope, headers);
}

/** Maps any thrown value to the error envelope; unexpected errors are logged and never leak details. */
export function writeThrown(res: ServerResponse, err: unknown, log: HubLog): void {
	if (err instanceof HubError) {
		writeError(res, err.status, err.code, err.message, err.headers ? { ...err.headers } : undefined);
		return;
	}
	log.error(`${LOG_PREFIX} 处理请求时出现未预期的错误: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	writeError(res, 500, "internalError", "服务器内部错误");
}
