const TIMEOUT_MS = 30_000;
const MAX_BYTES = 4 * 1024 * 1024;

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	query?: Record<string, string | number | boolean | undefined>;
	/** Objects are sent as JSON. */
	json?: unknown;
	form?: Record<string, string>;
	signal?: AbortSignal;
}

/** Only https leaves the machine; plain http is allowed for loopback development servers only. */
export function assertSafeUrl(raw: string): URL {
	const url = new URL(raw);
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`拒绝非 https 地址：${url.origin}`);
	return url;
}

/** Fill `{name}` placeholders from config and reject anything that could redirect the host. */
export function fill(template: string, config: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, k: string) => {
		const v = config[k];
		if (!v || !/^[\w.-]+$/.test(v)) throw new Error(`缺少或非法的配置项：${k}`);
		return v;
	});
}

async function readCapped(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_BYTES) {
			await reader.cancel();
			throw new Error(`响应超过 ${MAX_BYTES / 1024 / 1024}MB 上限`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function request<T = unknown>(rawUrl: string, opts: RequestOptions = {}): Promise<T> {
	const url = assertSafeUrl(rawUrl);
	for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
	const headers: Record<string, string> = { accept: "application/json", "user-agent": "prometheus-connectors", ...opts.headers };
	let body: string | undefined;
	if (opts.form) {
		headers["content-type"] = "application/x-www-form-urlencoded";
		body = new URLSearchParams(opts.form).toString();
	} else if (opts.json !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(opts.json);
	}
	const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
	// Never follow redirects automatically: an Authorization header must not travel to another host.
	const res = await fetch(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, signal, redirect: "manual" });
	const text = await readCapped(res);
	if (res.status >= 300 && res.status < 400) throw new HttpError(res.status, `被重定向到 ${res.headers.get("location") ?? "未知地址"}，已拒绝跟随`);
	if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 500)}`);
	if (!text) return undefined as T;
	try {
		return JSON.parse(text) as T;
	} catch {
		return text as T;
	}
}
