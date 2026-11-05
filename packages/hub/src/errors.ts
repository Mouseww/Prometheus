/** An error that maps to an HTTP status and a stable machine-readable code. */
export class HubError extends Error {
	readonly status: number;
	readonly code: string;
	readonly headers: Readonly<Record<string, string>> | undefined;

	constructor(status: number, code: string, message: string, headers?: Record<string, string>) {
		super(message);
		this.name = "HubError";
		this.status = status;
		this.code = code;
		this.headers = headers;
	}
}

export const badRequest = (message: string, code = "badRequest"): HubError => new HubError(400, code, message);
export const validationError = (message: string): HubError => new HubError(400, "validationError", message);
export const unauthorized = (message = "需要登录", code = "unauthorized"): HubError => new HubError(401, code, message);
export const forbidden = (message = "没有权限执行此操作", code = "forbidden"): HubError => new HubError(403, code, message);
export const notFound = (message = "资源不存在"): HubError => new HubError(404, "notFound", message);
export const conflict = (message: string, code = "conflict"): HubError => new HubError(409, code, message);
export const tooManyRequests = (retryAfterSec: number): HubError =>
	new HubError(429, "rateLimited", "请求过于频繁，请稍后再试", { "retry-after": String(Math.max(1, retryAfterSec)) });
