// Tool bus (docs/agent-runtime.md §4): exposes plugin tools to external runtimes as an MCP server over
// Streamable HTTP. One endpoint per session (`/mcp/<sessionId>`), authenticated by a per-session bearer token.
// Only the subset of MCP that agents use is implemented: initialize, ping, tools/list, tools/call,
// notifications/cancelled. Replies are plain JSON, or an SSE stream when the caller asked for progress.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PluginTool, PluginToolContext, PluginToolResult } from "@prometheus/plugin-sdk";

const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const BODY_LIMIT = 8 * 1024 * 1024;

/** What the adapter learns about every call, regardless of which runtime made it (§4.3: the bus is authoritative). */
export type BusToolEvent =
	| { type: "start"; toolCallId: string; name: string; args: unknown; meta?: unknown }
	| { type: "update"; toolCallId: string; name: string; partial: PluginToolResult }
	| { type: "end"; toolCallId: string; name: string; result: PluginToolResult; isError: boolean; durationMs: number };

export type BeforeCall = (call: { name: string; args: unknown; toolCallId: string }) => Promise<{ allow: true } | { allow: false; reason: string }> | { allow: true } | { allow: false; reason: string };

export interface BusSessionOptions {
	sessionId: string;
	cwd: () => string;
	/** The session's UI; `hasUI` is false for unattended runs. */
	ui: PluginToolContext["ui"];
	hasUI: () => boolean;
	/** Current tools; read on every request so hot-installed plugins appear without reconnecting. */
	tools: () => PluginTool[] | Promise<PluginTool[]>;
	/** Canonical names the session may use (modes, plan mode). Undefined = all. */
	allow?: () => ReadonlySet<string> | undefined;
	/** Permission check before a tool runs (the single permission gate, §6). */
	beforeCall?: BeforeCall;
	onEvent?: (event: BusToolEvent) => void;
}

export interface BusSession {
	sessionId: string;
	/** `http://127.0.0.1:<port>/mcp/<sessionId>` */
	url: string;
	/** Hand to the child process through its environment, never through a file. */
	token: string;
	/** Abort running calls and revoke the endpoint. */
	close(): void;
	/** Number of calls currently running. */
	running(): number;
}

interface Entry {
	opts: BusSessionOptions;
	token: Buffer;
	calls: Map<string | number, AbortController>;
	seq: number;
	closed: boolean;
}

interface JsonRpc {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: any;
}

export class ToolBus {
	private server: Server | undefined;
	private port = 0;
	private readonly sessions = new Map<string, Entry>();

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((req, res) => void this.handle(req, res).catch(() => this.fail(res, 500, -32603, "Internal error")));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		this.port = (server.address() as AddressInfo).port;
		this.server = server;
	}

	async stop(): Promise<void> {
		for (const e of this.sessions.values()) this.shutdown(e);
		this.sessions.clear();
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** Open (or replace) the endpoint of a session. */
	open(opts: BusSessionOptions): BusSession {
		if (!this.server) throw new Error("ToolBus is not started");
		const previous = this.sessions.get(opts.sessionId);
		if (previous) this.shutdown(previous);
		const token = randomBytes(24).toString("base64url");
		const entry: Entry = { opts, token: Buffer.from(token), calls: new Map(), seq: 0, closed: false };
		this.sessions.set(opts.sessionId, entry);
		return {
			sessionId: opts.sessionId,
			url: `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(opts.sessionId)}`,
			token,
			close: () => {
				this.shutdown(entry);
				if (this.sessions.get(opts.sessionId) === entry) this.sessions.delete(opts.sessionId);
			},
			running: () => entry.calls.size,
		};
	}

	private shutdown(e: Entry): void {
		e.closed = true;
		for (const c of e.calls.values()) c.abort();
		e.calls.clear();
	}

	private fail(res: ServerResponse, status: number, code: number, message: string, id: string | number | null = null): void {
		if (res.headersSent) {
			res.end();
			return;
		}
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
	}

	private authorize(e: Entry, req: IncomingMessage): boolean {
		const header = req.headers.authorization ?? "";
		const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
		return given.length === e.token.length && timingSafeEqual(given, e.token);
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const match = /^\/mcp\/([^/?]+)/.exec(req.url ?? "");
		let sessionId = "";
		try {
			sessionId = match ? decodeURIComponent(match[1]!) : "";
		} catch {
			/* falls through to 404 */
		}
		const entry = this.sessions.get(sessionId);
		if (!entry || entry.closed) return this.fail(res, 404, -32001, "Unknown session");
		if (!this.authorize(entry, req)) return this.fail(res, 401, -32001, "Unauthorized");
		if (req.method === "DELETE") {
			res.writeHead(200).end();
			return;
		}
		if (req.method === "GET") {
			// No server-initiated stream: tool list changes take effect on the next request.
			res.writeHead(405, { allow: "POST, DELETE" }).end();
			return;
		}
		if (req.method !== "POST") return this.fail(res, 405, -32600, "Method not allowed");

		const body = await readBody(req);
		if (body === undefined) return this.fail(res, 413, -32600, "Request too large");
		let message: JsonRpc | JsonRpc[];
		try {
			message = JSON.parse(body);
		} catch {
			return this.fail(res, 400, -32700, "Parse error");
		}
		if (Array.isArray(message)) return this.fail(res, 400, -32600, "Batch requests are not supported");
		if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return this.fail(res, 400, -32600, "Invalid request");

		// Notifications and responses carry no reply.
		if (message.id === undefined) {
			if (message.method === "notifications/cancelled") {
				const id = message.params?.requestId;
				entry.calls.get(id)?.abort();
			}
			res.writeHead(202).end();
			return;
		}
		const id = message.id;
		switch (message.method) {
			case "initialize": {
				const asked = String(message.params?.protocolVersion ?? "");
				return this.ok(res, id, {
					protocolVersion: SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "prometheus", version: "1" },
				});
			}
			case "ping":
				return this.ok(res, id, {});
			case "tools/list": {
				const tools = await this.visible(entry);
				return this.ok(res, id, {
					tools: tools.map((t) => ({
						name: t.name,
						title: t.label ?? t.name,
						description: t.description,
						inputSchema: toInputSchema(t.parameters),
						...(t.annotations?.readOnlyHint !== undefined ? { annotations: { readOnlyHint: t.annotations.readOnlyHint } } : {}),
					})),
				});
			}
			case "tools/call":
				return this.call(entry, req, res, id, message.params);
			default:
				return this.fail(res, 200, -32601, `Method not found: ${message.method}`, id);
		}
	}

	private ok(res: ServerResponse, id: string | number, result: unknown): void {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	private async visible(e: Entry): Promise<PluginTool[]> {
		const allow = e.opts.allow?.();
		const tools = await e.opts.tools();
		return allow ? tools.filter((t) => allow.has(t.name)) : tools;
	}

	private async call(e: Entry, req: IncomingMessage, res: ServerResponse, id: string | number, params: any): Promise<void> {
		const name = String(params?.name ?? "");
		const tool = (await this.visible(e)).find((t) => t.name === name);
		if (!tool) return this.fail(res, 200, -32602, `Unknown tool: ${name}`, id);
		const args = params?.arguments ?? {};
		const progressToken = params?._meta?.progressToken;
		const stream = progressToken !== undefined && String(req.headers.accept ?? "").includes("text/event-stream");

		const toolCallId = `bus-${++e.seq}`;
		const controller = new AbortController();
		e.calls.set(id, controller);
		// A client that hangs up cancels the call.
		const onClose = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.on("close", onClose);

		let sse = false;
		const send = (payload: unknown) => {
			if (!sse) {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				sse = true;
			}
			res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
		};
		const emit = (event: BusToolEvent) => {
			try {
				e.opts.onEvent?.(event);
			} catch {
				/* an observer must not break the call */
			}
		};

		const started = Date.now();
		emit({ type: "start", toolCallId, name, args, meta: params?._meta });
		let result: PluginToolResult;
		let isError = false;
		try {
			const verdict = e.opts.beforeCall ? await e.opts.beforeCall({ name, args, toolCallId }) : { allow: true as const };
			if (!verdict.allow) {
				result = { content: [{ type: "text", text: verdict.reason }], isError: true };
				isError = true;
			} else {
				const ctx: PluginToolContext = { cwd: e.opts.cwd(), sessionId: e.opts.sessionId, hasUI: e.opts.hasUI(), ui: e.opts.ui };
				let progress = 0;
				const onUpdate = (partial: PluginToolResult) => {
					emit({ type: "update", toolCallId, name, partial });
					if (stream && !controller.signal.aborted) {
						const text = partial.content?.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n") ?? "";
						send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++progress, message: text } });
					}
				};
				result = await tool.execute(toolCallId, args, controller.signal, onUpdate, ctx);
				isError = result?.isError === true;
			}
		} catch (err) {
			const text = controller.signal.aborted ? "Cancelled" : err instanceof Error ? err.message : String(err);
			result = { content: [{ type: "text", text }], isError: true };
			isError = true;
		} finally {
			e.calls.delete(id);
			res.off("close", onClose);
		}
		emit({ type: "end", toolCallId, name, result, isError, durationMs: Date.now() - started });
		if (controller.signal.aborted && res.destroyed) return;

		const payload = {
			jsonrpc: "2.0",
			id,
			result: {
				content: result.content ?? [],
				...(isError ? { isError: true } : {}),
				...(result.details !== undefined ? { structuredContent: toStructured(result.details) } : {}),
			},
		};
		if (sse) {
			send(payload);
			res.end();
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
		}
	}
}

/** MCP requires `inputSchema` to be an object schema. */
function toInputSchema(parameters: unknown): Record<string, unknown> {
	const schema = parameters && typeof parameters === "object" ? { ...(parameters as Record<string, unknown>) } : {};
	if (schema.type !== "object") return { type: "object", properties: {} };
	return schema;
}

/** `structuredContent` must be an object. */
function toStructured(details: unknown): Record<string, unknown> {
	return details && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : { value: details };
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
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
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => resolve(undefined));
	});
}
