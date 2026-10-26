// A scripted anthropic-messages server for conformance tests (docs/agent-runtime.md §10).
// Every runtime talks to it through the gateway relay, so no real API is used and runs are reproducible.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeBlock = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown; id?: string };

/** One assistant response. `delayMs` slows the stream so tests can abort mid-way; `status` simulates an upstream error. */
export interface FakeTurn {
	/** Fixed blocks, or computed from the request (to echo what the model was sent). */
	blocks?: FakeBlock[] | ((req: RecordedRequest) => FakeBlock[]);
	status?: number;
	delayMs?: number;
}

export interface RecordedRequest {
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: any;
	/** All system text, flattened. */
	system: string;
	/** Text of the last user message. */
	lastUser: string;
}

export class FakeLlm {
	private server: Server | undefined;
	readonly requests: RecordedRequest[] = [];
	private script: FakeTurn[] = [];
	private seq = 0;
	private fallback: FakeTurn = { blocks: [{ type: "text", text: "ok" }] };

	get baseUrl(): string {
		return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
	}

	/** Queue turns; once exhausted the fallback answers. */
	enqueue(...turns: FakeTurn[]): void {
		this.script.push(...turns);
	}

	reset(): void {
		this.script = [];
		this.requests.length = 0;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => void this.answer(req.url ?? "", req.headers, Buffer.concat(chunks).toString(), res));
		});
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
	}

	async stop(): Promise<void> {
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
	}

	private async answer(path: string, headers: RecordedRequest["headers"], raw: string, res: import("node:http").ServerResponse): Promise<void> {
		let body: any = {};
		try {
			body = JSON.parse(raw);
		} catch {
			/* not json */
		}
		const system = Array.isArray(body.system) ? body.system.map((s: any) => s.text ?? "").join("\n") : String(body.system ?? "");
		const users = (body.messages ?? []).filter((m: any) => m.role === "user");
		const last = users.at(-1)?.content;
		const lastUser = typeof last === "string" ? last : (last ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "tool_result" ? `[tool_result]${JSON.stringify(c.content)}` : "")).join("\n");
		this.requests.push({ path, headers, body, system, lastUser });

		const turn = this.script.shift() ?? this.fallback;
		if (turn.status && turn.status >= 400) {
			res.writeHead(turn.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "scripted failure" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		const wait = () => (turn.delayMs ? new Promise((r) => setTimeout(r, turn.delayMs)) : undefined);
		const recorded = this.requests.at(-1)!;
		const blocks = (typeof turn.blocks === "function" ? turn.blocks(recorded) : turn.blocks) ?? [{ type: "text" as const, text: "ok" }];
		send("message_start", {
			type: "message_start",
			message: { id: `msg_${this.requests.length}`, type: "message", role: "assistant", model: body.model ?? "fake", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
		});
		let index = 0;
		let usedTool = false;
		for (const block of blocks) {
			if (block.type === "text") {
				send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
				// Split in two so streaming (and placeholders split across chunks) is exercised.
				const mid = Math.ceil(block.text.length / 2);
				for (const part of [block.text.slice(0, mid), block.text.slice(mid)]) {
					if (!part) continue;
					send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
					await wait();
				}
			} else {
				usedTool = true;
				send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id ?? `toolu_${index}_${++this.seq}`, name: block.name, input: {} } });
				send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
				await wait();
			}
			send("content_block_stop", { type: "content_block_stop", index });
			index++;
		}
		send("message_delta", { type: "message_delta", delta: { stop_reason: usedTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
		send("message_stop", { type: "message_stop" });
		res.end();
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The same idea for the OpenAI Responses API (what Codex speaks).

export type FakeResponsesBlock =
	| { type: "text"; text: string }
	| { type: "shell"; command: string }
	/** A tool of the Prometheus MCP server, looked up in the tools Codex offered. */
	| { type: "mcp"; tool: string; input: unknown }
	| { type: "function"; name: string; input: unknown };

export interface FakeResponsesTurn {
	blocks?: FakeResponsesBlock[] | ((req: RecordedResponsesRequest) => FakeResponsesBlock[]);
	status?: number;
	delayMs?: number;
}

export interface RecordedResponsesRequest {
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: any;
	instructions: string;
	/** Text of the last user input message (including the per-turn context item). */
	lastUser: string;
	/** Everything sent as input, flattened to text, for "was X in the conversation" checks. */
	inputText: string;
	toolNames: string[];
}

export class FakeResponsesLlm {
	private server: Server | undefined;
	readonly requests: RecordedResponsesRequest[] = [];
	private script: FakeResponsesTurn[] = [];
	private seq = 0;

	get baseUrl(): string {
		return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
	}

	enqueue(...turns: FakeResponsesTurn[]): void {
		this.script.push(...turns);
	}
	reset(): void {
		this.script = [];
		this.requests.length = 0;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => void this.answer(req.url ?? "", req.headers, Buffer.concat(chunks).toString(), res));
		});
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
	}
	async stop(): Promise<void> {
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
	}

	private findMcp(tools: any[], tool: string): { name: string; namespace?: string } | undefined {
		for (const t of tools ?? []) {
			if (t.type === "function" && (t.name === tool || t.name.endsWith(`__${tool}`))) return { name: t.name };
			if (t.type === "namespace") for (const f of t.tools ?? []) if (f.name === tool) return { name: f.name, namespace: t.name };
		}
		return undefined;
	}

	private async answer(path: string, headers: RecordedResponsesRequest["headers"], raw: string, res: import("node:http").ServerResponse): Promise<void> {
		if (!path.includes("/responses")) {
			res.writeHead(404).end();
			return;
		}
		let body: any = {};
		try {
			body = JSON.parse(raw);
		} catch {
			/* not json */
		}
		const input: any[] = body.input ?? [];
		const texts = (m: any) => (Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("\n") : String(m.content ?? ""));
		const users = input.filter((i) => i.type === "message" && i.role === "user");
		const outputs = input.filter((i) => i.type === "function_call_output").map((i) => `[tool_output]${typeof i.output === "string" ? i.output : JSON.stringify(i.output)}`);
		const lastUserMsg = users.at(-1);
		const lastIsOutput = input.at(-1)?.type === "function_call_output";
		const recorded: RecordedResponsesRequest = {
			path,
			headers,
			body,
			instructions: String(body.instructions ?? ""),
			lastUser: lastIsOutput ? outputs.at(-1)! : lastUserMsg ? texts(lastUserMsg) : "",
			inputText: input.map((i) => (i.type === "message" ? texts(i) : i.type === "function_call_output" ? String(i.output) : JSON.stringify(i))).join("\n"),
			toolNames: (body.tools ?? []).flatMap((t: any) => (t.type === "namespace" ? (t.tools ?? []).map((f: any) => `${t.name}${f.name}`) : [t.name ?? t.type])),
		};
		this.requests.push(recorded);

		const turn = this.script.shift() ?? { blocks: [{ type: "text" as const, text: "ok" }] };
		if (turn.status && turn.status >= 400) {
			res.writeHead(turn.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { type: "server_error", message: "scripted failure" } }));
			return;
		}
		const blocks = (typeof turn.blocks === "function" ? turn.blocks(recorded) : turn.blocks) ?? [{ type: "text" as const, text: "ok" }];
		res.writeHead(200, { "content-type": "text/event-stream" });
		const ev = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
		const rid = `resp_${++this.seq}`;
		ev("response.created", { response: { id: rid } });
		let index = 0;
		for (const block of blocks) {
			const id = `${block.type === "text" ? "msg" : "fc"}_${rid}_${index}`;
			if (block.type === "text") {
				const base = { type: "message", role: "assistant", id, content: [] as any[] };
				ev("response.output_item.added", { output_index: index, item: base });
				const mid = Math.ceil(block.text.length / 2);
				for (const part of [block.text.slice(0, mid), block.text.slice(mid)]) {
					if (!part) continue;
					ev("response.output_text.delta", { item_id: id, output_index: index, content_index: 0, delta: part });
					if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
				}
				ev("response.output_item.done", { output_index: index, item: { ...base, content: [{ type: "output_text", text: block.text, annotations: [] }] } });
			} else {
				let item: any;
				if (block.type === "shell") item = { type: "function_call", id, call_id: `call_${rid}_${index}`, name: "shell_command", arguments: JSON.stringify({ command: block.command }) };
				else if (block.type === "mcp") {
					const found = this.findMcp(body.tools, block.tool) ?? { name: block.tool };
					item = { type: "function_call", id, call_id: `call_${rid}_${index}`, ...found, arguments: JSON.stringify(block.input) };
				} else item = { type: "function_call", id, call_id: `call_${rid}_${index}`, name: block.name, arguments: JSON.stringify(block.input) };
				ev("response.output_item.done", { output_index: index, item });
				if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
			}
			index++;
		}
		ev("response.completed", { response: { id: rid, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } });
		res.end();
	}
}
