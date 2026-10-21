/**
 * The local relay used by "出口代理" mode.
 *
 * Prometheus hands this a request that was meant for an upstream API. The relay
 *  1. desensitises the body (JSON or text) against the rule set,
 *  2. rewrites the region-bearing headers,
 *  3. forwards it through the configured proxy,
 *  4. restores placeholders in the response — including streaming SSE — before returning it.
 *
 * If step 4 cannot run (the mapping table failed), the relay answers 502 rather than passing a
 * response full of `{{PHONE_…}}` to the caller. Nothing leaves the machine that was not scanned.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isDataUrlBase64, shouldSkipDesensitize } from "../engine/binary.ts";
import type { RuleSet } from "../engine/rules.ts";
import { RestoreWindow } from "../engine/sliding.ts";
import { findPlaceholders } from "../engine/placeholder.ts";
import type { MappingStore } from "../engine/store.ts";
import { desensitizeJson, desensitizeString, parseJson, restoreJson, restoreString } from "../engine/walk.ts";
import { proxyAgent, type ProxySettings } from "./transport.ts";

export interface RelayOptions {
	/** Bind address; loopback only. */
	host: string;
	port: number;
	rules: () => RuleSet;
	store: MappingStore;
	proxy: () => ProxySettings;
	/** `en-US,en;q=0.9` — sent when the profile is region-neutral. */
	acceptLanguage: () => string;
	regionNeutral: () => boolean;
	/** Requests larger than this are rejected instead of buffered. */
	bodyLimitBytes: () => number;
	/** gateway id -> real upstream base URL, so a bare-path request finds its destination. */
	routes: () => Record<string, string>;
	/** Fallback upstream when no route matches. */
	defaultUpstream: () => string;
	log: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

export interface RelayHit {
	at: number;
	method: string;
	path: string;
	/** Upstream host the request was forwarded to. */
	upstream: string;
	/** Placeholder types used, deduplicated. */
	types: string[];
	status: number;
	durationMs: number;
	/** Bytes saved/added by rewriting, for the panel. */
	redacted: number;
}

export interface RelayStatus {
	running: boolean;
	host: string;
	port: number;
	/** `http://127.0.0.1:<port>` — set this as a gateway base URL to route through the relay. */
	baseUrl: string;
	error?: string;
}

/** Request headers that must not be copied onto the forwarded request. */
const HOP_BY_HOP = new Set(["host", "accept-encoding", "content-length", "transfer-encoding", "connection", "proxy-connection", "keep-alive", "upgrade", "te", "trailer"]);

/** Response headers a relay must not forward verbatim. */
const RESPONSE_DROP = new Set(["transfer-encoding", "connection", "content-length", "keep-alive"]);

export class VeilRelay {
	private server: Server | undefined;
	private error: string | undefined;
	private readonly hits: RelayHit[] = [];
	private readonly agents = new Map<string, ReturnType<typeof proxyAgent>>();

	private readonly options: RelayOptions;

	constructor(options: RelayOptions) {
		this.options = options;
	}

	status(): RelayStatus {
		const addr = this.server?.address();
		const port = typeof addr === "object" && addr ? addr.port : this.options.port;
		return {
			running: Boolean(this.server?.listening),
			host: this.options.host,
			port,
			baseUrl: `http://${this.options.host}:${port}`,
			...(this.error ? { error: this.error } : {}),
		};
	}

	recentHits(limit = 50): RelayHit[] {
		return this.hits.slice(-limit).reverse();
	}

	clearHits(): void {
		this.hits.length = 0;
	}

	async start(): Promise<RelayStatus> {
		if (this.server?.listening) return this.status();
		this.error = undefined;
		const server = createServer((req, res) => {
			this.handle(req, res).catch((err: unknown) => {
				this.options.log.error(`转发失败：${err instanceof Error ? err.message : String(err)}`);
				if (!res.headersSent) jsonError(res, 502, err instanceof Error ? err.message : "转发失败");
				else res.end();
			});
		});
		// The SDKs keep long-lived SSE streams open; a short header timeout would cut them off.
		server.headersTimeout = 120_000;
		server.requestTimeout = 0;
		this.server = server;

		return new Promise<RelayStatus>((resolve) => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				this.error = err.code === "EADDRINUSE" ? `端口 ${this.options.port} 已被占用` : err.message;
				this.server = undefined;
				resolve(this.status());
			});
			server.listen(this.options.port, this.options.host, () => resolve(this.status()));
		});
	}

	async stop(): Promise<void> {
		for (const agent of this.agents.values()) agent.destroy();
		this.agents.clear();
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private agentFor(proxy: ProxySettings, secure: boolean) {
		const key = `${secure ? "tls" : "tcp"}|${proxy.kind}|${proxy.server}|${proxy.username ?? ""}`;
		let agent = this.agents.get(key);
		if (!agent) {
			agent = proxyAgent(proxy, secure);
			this.agents.set(key, agent);
		}
		return agent;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const started = Date.now();
		const { host, port, secure, path, query } = this.resolveTarget(req);
		const method = req.method ?? "GET";
		const upstream = `${secure ? "https" : "http"}://${host}${port ? `:${port}` : ""}`;

		// A relative-path request needs an upstream; the panel tells the user to set one.
		if (!host) return jsonError(res, 500, "没有配置上游地址：请在面罩面板的「代理」里填写要转发的目标");

		const raw = await readBody(req, this.options.bodyLimitBytes());
		if (raw === undefined) return jsonError(res, 413, "请求体过大");

		const proxy = this.options.proxy();
		const rules = this.options.rules();
		const types = new Set<string>();

		let body: Buffer = raw;
		if (raw.length > 0) {
			const rewritten = this.redact(raw, req.headers["content-type"], rules, types);
			if (!rewritten.ok) return jsonError(res, 502, rewritten.error);
			body = rewritten.body;
		}

		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (!value || HOP_BY_HOP.has(name.toLowerCase())) continue;
			headers[name] = value;
		}
		headers.host = port && !isDefaultPort(port, secure) ? `${host}:${port}` : host;
		if (body.length > 0) headers["content-length"] = String(body.length);
		if (this.options.regionNeutral()) {
			headers["accept-language"] = this.options.acceptLanguage();
			// Compression would hide the placeholders from the response rewriter.
			headers["accept-encoding"] = "identity";
		}

		const requestFn = secure ? httpsRequest : httpRequest;
		const request = requestFn(
			{
				host,
				port,
				path: query ? `${path}?${query}` : path,
				method,
				headers,
				agent: this.agentFor(proxy, secure),
				servername: host,
			},
			(upstreamRes) => this.pipeResponse(upstreamRes, res, { method, path, upstream, types, started }),
		);

		request.on("error", (err) => {
			if (!res.headersSent) jsonError(res, 502, `连接上游失败：${err.message}`);
			else res.end();
		});
		// Client hung up first; stop the upstream request too.
		res.on("close", () => {
			if (!res.writableFinished) request.destroy();
		});
		if (body.length > 0) request.write(body);
		request.end();
	}

	/** Desensitises a request body, returning a 502 reason when the rule engine cannot complete. */
	private redact(raw: Buffer, contentType: string | undefined, rules: RuleSet, types: Set<string>): { ok: true; body: Buffer } | { ok: false; error: string } {
		const looksJson = (contentType ?? "").toLowerCase().includes("json") || /^[\s]*[[{]/.test(raw.subarray(0, 64).toString("utf8"));
		if (looksJson) {
			const parsed = parseJson(raw.toString("utf8"));
			if (parsed === undefined) return { ok: true, body: raw };
			try {
				const redacted = desensitizeJson(parsed, rules, this.options.store);
				collectTypes(parsed, redacted, rules, types);
				return { ok: true, body: Buffer.from(JSON.stringify(redacted), "utf8") };
			} catch (err) {
				return { ok: false, error: `脱敏失败：${err instanceof Error ? err.message : String(err)}` };
			}
		}

		const text = raw.toString("utf8");
		// Binary or a multimodal blob: leave it byte-identical rather than risk corrupting it.
		if (shouldSkipDesensitize(undefined, text) || isDataUrlBase64(text)) return { ok: true, body: raw };
		const hits = rules.findHits(text);
		if (hits.length === 0) return { ok: true, body: raw };
		for (const hit of hits) types.add(hit.typePrefix);
		return { ok: true, body: Buffer.from(desensitizeString(text, rules, this.options.store), "utf8") };
	}

	private pipeResponse(upstreamRes: IncomingMessage, res: ServerResponse, ctx: { method: string; path: string; upstream: string; types: Set<string>; started: number }): void {
		const status = upstreamRes.statusCode ?? 502;
		const contentType = String(upstreamRes.headers["content-type"] ?? "");
		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Object.entries(upstreamRes.headers)) {
			if (value === undefined || RESPONSE_DROP.has(name.toLowerCase())) continue;
			headers[name] = value;
		}

		const isEventStream = contentType.toLowerCase().includes("text/event-stream");

		if (isEventStream) {
			// Stream: restore token by token; the window holds split placeholders across chunks.
			res.writeHead(status, headers);
			const window = new RestoreWindow(this.options.store);
			let buffer = "";
			upstreamRes.setEncoding("utf8");
			upstreamRes.on("data", (chunk: string) => {
				buffer += chunk;
				const restored = restoreEventStream(buffer, window, false);
				buffer = restored.rest;
				if (restored.out) res.write(restored.out);
			});
			upstreamRes.on("end", () => {
				const tail = restoreEventStream(buffer, window, true);
				if (tail.out) res.write(tail.out);
				const flushed = window.flush();
				if (flushed) res.write(flushed);
				this.record(ctx, status);
				res.end();
			});
			upstreamRes.on("error", (err) => {
				this.options.log.warn(`上游流中断：${err.message}`);
				res.end();
			});
			return;
		}

		const chunks: Buffer[] = [];
		upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
		upstreamRes.on("error", (err) => {
			if (!res.headersSent) jsonError(res, 502, `读取上游响应失败：${err.message}`);
			else res.end();
		});
		upstreamRes.on("end", () => {
			const raw = Buffer.concat(chunks);
			let out = raw;
			const looksJson = contentType.toLowerCase().includes("json") || /^[\s]*[[{]/.test(raw.subarray(0, 64).toString("utf8"));
			if (looksJson) {
				const parsed = parseJson(raw.toString("utf8"));
				if (parsed !== undefined) out = Buffer.from(JSON.stringify(restoreJson(parsed, this.options.store)), "utf8");
			} else if (!shouldSkipDesensitize(undefined, raw.toString("utf8"))) {
				out = Buffer.from(restoreString(raw.toString("utf8"), this.options.store), "utf8");
			}
			headers["content-length"] = String(out.length);
			res.writeHead(status, headers);
			this.record(ctx, status);
			res.end(out);
		});
	}

	/**
	 * Splits an SSE buffer into complete events, restores the `data:` payloads, and returns the
	 * unfinished remainder. Mirrors veil's `sse.rs`, but reuses one window for the whole stream.
	 */
	private record(ctx: { method: string; path: string; upstream: string; types: Set<string>; started: number }, status: number): void {
		this.hits.push({
			at: Date.now(),
			method: ctx.method,
			path: ctx.path,
			upstream: ctx.upstream,
			types: [...ctx.types],
			status,
			durationMs: Date.now() - ctx.started,
			redacted: ctx.types.size,
		});
		if (this.hits.length > 200) this.hits.splice(0, this.hits.length - 200);
	}

	/**
	 * Upstream target for a forwarded request.
	 *
	 * The SDKs request bare paths (`/v1/messages`), so the destination comes from, in order:
	 * an `x-veil-upstream` header (tests and manual calls), an absolute request URL, or the
	 * gateway route table configured when the relay was switched on.
	 */
	private resolveTarget(req: IncomingMessage): { host: string; port: number; secure: boolean; path: string; query: string } {
		const raw = req.url ?? "/";
		const splitPath = (value: string) => {
			const q = value.indexOf("?");
			return q === -1 ? { path: value, query: "" } : { path: value.slice(0, q), query: value.slice(q + 1) };
		};
		const routeFor = (url: URL) => {
			const secure = url.protocol === "https:";
			const { path, query } = splitPath(raw);
			return {
				host: url.hostname,
				port: Number(url.port) || (secure ? 443 : 80),
				secure,
				path: joinPath(url.pathname, path),
				query,
			};
		};

		const explicit = req.headers["x-veil-upstream"];
		if (explicit) {
			const url = safeUrl(String(explicit));
			if (url) return routeFor(url);
		}
		const absolute = safeUrl(raw);
		if (absolute) return routeFor(absolute);

		const { path, query } = splitPath(raw);
		const routes = this.options.routes();
		// Longest path prefix wins, so `/v1/responses` beats a bare `/v1`.
		let best: { route: string; url: URL } | undefined;
		for (const value of Object.values(routes)) {
			const url = safeUrl(value);
			if (!url) continue;
			const prefix = url.pathname.replace(/\/+$/, "");
			if (prefix && !path.startsWith(prefix)) continue;
			if (!best || prefix.length > best.route.length) best = { route: prefix, url };
		}
		const fallback = safeUrl(this.options.defaultUpstream());
		const chosen = best?.url ?? fallback;
		if (!chosen) return { host: "", port: 0, secure: false, path, query };

		const secure = chosen.protocol === "https:";
		// Strip the matched prefix so the upstream sees the path its SDK would have sent.
		const rest = best?.route ? path.slice(best.route.length) || "/" : path;
		return {
			host: chosen.hostname,
			port: Number(chosen.port) || (secure ? 443 : 80),
			secure,
			path: joinPath(best ? "" : chosen.pathname, rest),
			query,
		};
	}
}

/** Concatenates URL path pieces without doubling or dropping the separator. */
function joinPath(prefix: string, suffix: string): string {
	const left = prefix.replace(/\/+$/, "");
	const right = suffix.startsWith("/") ? suffix : `/${suffix}`;
	return `${left}${right}` || "/";
}

function collectTypes(before: unknown, after: unknown, _rules: RuleSet, types: Set<string>): void {
	const collect = (value: unknown, into: Set<string>) => {
		if (typeof value === "string") {
			for (const found of findPlaceholders(value)) into.add(found.parsed.typePrefix);
		} else if (Array.isArray(value)) {
			for (const item of value) collect(item, into);
		} else if (value && typeof value === "object") {
			for (const child of Object.values(value)) collect(child, into);
		}
	};
	const already = new Set<string>();
	collect(before, already);
	const result = new Set<string>();
	collect(after, result);
	for (const type of result) if (!already.has(type)) types.add(type);
}

function isDefaultPort(port: number, secure: boolean): boolean {
	return (secure && port === 443) || (!secure && port === 80);
}

function safeUrl(raw: string): URL | undefined {
	try {
		return new URL(raw);
	} catch {
		return undefined;
	}
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				resolve(undefined);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function jsonError(res: ServerResponse, status: number, message: string): void {
	const body = JSON.stringify({ error: { type: "veil_relay", message } });
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

/** Exported for tests: restores one SSE buffer, returning the untouched remainder. */
export function restoreEventStream(buffer: string, window: RestoreWindow, flush: boolean): { out: string; rest: string } {
	let rest = buffer;
	let out = "";
	for (;;) {
		const crlf = rest.indexOf("\r\n\r\n");
		const lf = rest.indexOf("\n\n");
		const idx = crlf === -1 ? lf : lf === -1 ? crlf : Math.min(crlf, lf);
		if (idx === -1) break;
		const end = crlf !== -1 && idx === crlf ? idx + 4 : idx + 2;
		const event = rest.slice(0, idx);
		rest = rest.slice(end);
		out += `${restoreEvent(event, window)}\n\n`;
	}
	if (flush && rest.trim()) {
		out += restoreEvent(rest.trimEnd(), window);
		rest = "";
	}
	return { out, rest };
}

function restoreEvent(event: string, window: RestoreWindow): string {
	const meta: string[] = [];
	const dataParts: string[] = [];
	for (const rawLine of event.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
		else meta.push(line);
	}
	if (dataParts.length === 0) return event;
	const data = dataParts.join("\n");
	meta.push(`data: ${restorePayload(data, window)}`);
	return meta.join("\n");
}

/**
 * Restores one SSE payload. A streamed delta goes through the sliding window so a placeholder
 * split across two events still resolves; anything else is a whole JSON document.
 */
function restorePayload(data: string, window: RestoreWindow): string {
	if (data === "[DONE]") return data;
	const parsed = parseJson(data);
	if (parsed === undefined) return restoreString(data, window.store);
	const slot = findDeltaText(parsed);
	if (slot) {
		slot.set(window.push(slot.get()));
		return JSON.stringify(parsed);
	}
	return JSON.stringify(restoreJson(parsed, window.store));
}

interface TextSlot {
	get(): string;
	set(value: string): void;
}

/** Locates the incremental text field of an OpenAI/Anthropic stream event. */
function findDeltaText(value: unknown): TextSlot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;

	const slotFor = (holder: Record<string, unknown>, key: string): TextSlot | undefined =>
		typeof holder[key] === "string" ? { get: () => holder[key] as string, set: (v) => (holder[key] = v) } : undefined;

	const delta = obj.delta;
	if (delta && typeof delta === "object") {
		const d = delta as Record<string, unknown>;
		// Anthropic: { delta: { type: "text_delta", text } } and { delta: { partial_json } }.
		const text = slotFor(d, "text") ?? slotFor(d, "partial_json");
		if (text) return text;
	}
	const choices = obj.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		// OpenAI: { choices: [{ delta: { content } }] }.
		const first = choices[0];
		if (first && typeof first === "object") {
			const d = (first as Record<string, unknown>).delta;
			if (d && typeof d === "object") return slotFor(d as Record<string, unknown>, "content");
		}
	}
	return undefined;
}
