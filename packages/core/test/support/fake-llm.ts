// A scripted anthropic-messages server for conformance tests (docs/agent-runtime.md §10).
// Every runtime talks to it through the gateway relay, so no real API is used and runs are reproducible.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeBlock = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown; id?: string };

/** One assistant response. `delayMs` slows the stream so tests can abort mid-way; `status` simulates an upstream error. */
export interface FakeTurn {
	blocks?: FakeBlock[];
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
		const blocks = turn.blocks ?? [{ type: "text", text: "ok" }];
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
