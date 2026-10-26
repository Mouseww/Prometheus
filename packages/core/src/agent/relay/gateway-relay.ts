// Gateway relay (docs/agent-runtime.md §7): a loopback reverse proxy between an agent runtime and a model gateway.
// The child process only ever sees `baseUrl` and a per-session token; the real key is injected here, so it never
// reaches a subprocess environment, CLI log or config file. Hooks let veil rewrite requests and restore responses
// for every runtime through one path.
import { createServer, type IncomingHttpHeaders, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Agent } from "node:http";
import type { GatewayConfig } from "@prometheus/protocol";

const BODY_LIMIT = 64 * 1024 * 1024;
const HOP_BY_HOP = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length"]);
const CLIENT_AUTH = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

export interface RelayRequestInfo {
	sessionId: string;
	gatewayId: string;
	method: string;
	/** Path as the client sent it, without query. */
	path: string;
	contentType: string;
}

/** Rewrites response text incrementally (SSE or JSON). `end` flushes anything held back. */
export interface ResponseRewriter {
	write(text: string): string;
	end(): string;
}

export interface RelayExchange extends RelayRequestInfo {
	upstream: string;
	status: number;
	durationMs: number;
	requestBytes: number;
	responseBytes: number;
}

export interface GatewayRelayOptions {
	/** Rewrite the request body before it is forwarded (veil desensitization). Throwing fails the request with 502. */
	onRequest?: (info: RelayRequestInfo, body: Buffer) => Buffer | Promise<Buffer>;
	/** Restore the response; return undefined to pass it through byte-for-byte. */
	onResponse?: (info: RelayRequestInfo) => ResponseRewriter | undefined;
	/** Upstream proxy agent (the veil exit proxy). */
	agent?: (secure: boolean) => Agent | undefined;
	/** Called once per finished exchange, for usage and the activity panel. */
	onExchange?: (exchange: RelayExchange) => void;
	log?: { warn(message: string): void };
}

export interface RelayGrant {
	sessionId: string;
	/** `http://127.0.0.1:<port>` — set as the runtime's base URL (add `/v1` when the runtime expects it). */
	baseUrl: string;
	/** Present as the API key / bearer token. Meaningless outside this process. */
	token: string;
	revoke(): void;
}

interface Grant {
	sessionId: string;
	token: Buffer;
	gateway: () => GatewayConfig | undefined;
	gatewayId: string;
}

export class GatewayRelay {
	private server: Server | undefined;
	private port = 0;
	private readonly grants = new Map<string, Grant>();
	private readonly options: GatewayRelayOptions;

	constructor(options: GatewayRelayOptions = {}) {
		this.options = options;
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((req, res) => {
			this.handle(req, res).catch((err: unknown) => this.fail(res, 502, err instanceof Error ? err.message : String(err)));
		});
		server.headersTimeout = 120_000;
		server.requestTimeout = 0;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		this.port = (server.address() as AddressInfo).port;
		this.server = server;
	}

	async stop(): Promise<void> {
		this.grants.clear();
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/**
	 * Lets a session talk to a gateway through the relay. `gateway` is read per request, so edits to the
	 * gateway (rotated key, new base URL) apply to running sessions.
	 */
	grant(sessionId: string, gatewayId: string, gateway: () => GatewayConfig | undefined): RelayGrant {
		if (!this.server) throw new Error("GatewayRelay is not started");
		const token = `pmt_${randomBytes(24).toString("base64url")}`;
		this.grants.set(token, { sessionId, token: Buffer.from(token), gateway, gatewayId });
		return {
			sessionId,
			baseUrl: `http://127.0.0.1:${this.port}`,
			token,
			revoke: () => void this.grants.delete(token),
		};
	}

	private fail(res: ServerResponse, status: number, message: string): void {
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { type: "relay_error", message } }));
	}

	private identify(headers: IncomingHttpHeaders): Grant | undefined {
		const auth = headers.authorization;
		const candidates = [typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "", String(headers["x-api-key"] ?? ""), String(headers["api-key"] ?? "")];
		for (const given of candidates) {
			if (!given) continue;
			const grant = this.grants.get(given);
			if (!grant) continue;
			const a = Buffer.from(given);
			if (a.length === grant.token.length && timingSafeEqual(a, grant.token)) return grant;
		}
		return undefined;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const grant = this.identify(req.headers);
		if (!grant) return this.fail(res, 401, "Unknown or revoked relay token");
		const gateway = grant.gateway();
		if (!gateway || gateway.enabled === false) return this.fail(res, 502, `Gateway ${grant.gatewayId} is not available`);

		const started = Date.now();
		const url = new URL(req.url ?? "/", "http://relay.local");
		const info: RelayRequestInfo = {
			sessionId: grant.sessionId,
			gatewayId: grant.gatewayId,
			method: req.method ?? "GET",
			path: url.pathname,
			contentType: String(req.headers["content-type"] ?? ""),
		};

		let body = await readBody(req);
		if (body === undefined) return this.fail(res, 413, "Request body too large");
		const requestBytes = body.length;
		if (this.options.onRequest && body.length > 0) {
			try {
				body = await this.options.onRequest(info, body);
			} catch (err) {
				return this.fail(res, 502, `Request rewrite failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const target = upstreamUrl(gateway, url);
		const secure = target.protocol === "https:";
		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			const lower = name.toLowerCase();
			if (value === undefined || HOP_BY_HOP.has(lower) || CLIENT_AUTH.has(lower)) continue;
			headers[name] = value;
		}
		Object.assign(headers, gatewayAuth(gateway));
		headers.host = target.host;
		if (body.length > 0) headers["content-length"] = String(body.length);
		// Compressed bodies would hide text from the rewriter.
		if (this.options.onResponse) headers["accept-encoding"] = "identity";

		const rewriter = this.options.onResponse?.(info);
		const upstream = `${target.protocol}//${target.host}`;
		const send = secure ? httpsRequest : httpRequest;
		const upstreamReq = send(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port || (secure ? 443 : 80),
				path: `${target.pathname}${target.search}`,
				method: info.method,
				headers,
				agent: this.options.agent?.(secure),
				servername: target.hostname,
			},
			(upstreamRes) => {
				const status = upstreamRes.statusCode ?? 502;
				const outHeaders: Record<string, string | string[]> = {};
				for (const [name, value] of Object.entries(upstreamRes.headers)) {
					if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
					outHeaders[name] = value;
				}
				let responseBytes = 0;
				const done = () => {
					this.options.onExchange?.({ ...info, upstream, status, durationMs: Date.now() - started, requestBytes, responseBytes });
				};
				if (!rewriter) {
					res.writeHead(status, outHeaders);
					upstreamRes.on("data", (c: Buffer) => {
						responseBytes += c.length;
						res.write(c);
					});
					upstreamRes.on("end", () => {
						done();
						res.end();
					});
					upstreamRes.on("error", () => res.end());
					return;
				}
				// Rewritten text has a different length and arrives incrementally.
				delete outHeaders["content-length"];
				res.writeHead(status, outHeaders);
				upstreamRes.setEncoding("utf8");
				upstreamRes.on("data", (chunk: string) => {
					responseBytes += Buffer.byteLength(chunk);
					const out = rewriter.write(chunk);
					if (out) res.write(out);
				});
				upstreamRes.on("end", () => {
					const tail = rewriter.end();
					if (tail) res.write(tail);
					done();
					res.end();
				});
				upstreamRes.on("error", (err) => {
					this.options.log?.warn(`upstream stream broke: ${err.message}`);
					res.end();
				});
			},
		);
		upstreamReq.on("error", (err) => this.fail(res, 502, `Cannot reach upstream: ${err.message}`));
		// The runtime hung up (abort): stop the upstream request too.
		res.on("close", () => {
			if (!res.writableFinished) upstreamReq.destroy();
		});
		if (body.length > 0) upstreamReq.write(body);
		upstreamReq.end();
	}
}

/** Joins the gateway base URL with the request path; a base ending in /v1 absorbs the client's own /v1. */
export function upstreamUrl(gateway: GatewayConfig, requested: URL): URL {
	const base = new URL(gateway.baseUrl.replace(/\/+$/, ""));
	let path = requested.pathname;
	const basePath = base.pathname.replace(/\/+$/, "");
	if (/\/v1$/i.test(basePath) && /^\/v1(\/|$)/i.test(path)) path = path.slice(3);
	const out = new URL(base.toString());
	out.pathname = `${basePath}${path}`;
	out.search = requested.search;
	return out;
}

/** Real credentials for the upstream request, per the gateway's auth mode. */
export function gatewayAuth(g: GatewayConfig): Record<string, string> {
	const out: Record<string, string> = { ...(g.headers ?? {}) };
	const key = g.apiKey ?? "";
	switch (g.auth.type) {
		case "none":
			break;
		case "header":
			out[g.auth.header] = `${g.auth.prefix ?? ""}${key}`;
			break;
		case "bearer":
			out.authorization = `Bearer ${key}`;
			break;
		case "native":
			if (g.format === "anthropic-messages") out["x-api-key"] = key;
			else if (g.format === "google-generative-ai") out["x-goog-api-key"] = key;
			else out.authorization = `Bearer ${key}`;
			break;
	}
	return out;
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > BODY_LIMIT) {
				resolve(undefined);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", () => resolve(undefined));
	});
}
