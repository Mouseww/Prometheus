// Minimal stdio MCP server for smoke tests: one `echo` tool.
import { createInterface } from "node:readline";

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	const msg = JSON.parse(line) as { id?: number; method: string; params?: { arguments?: { text?: string }; protocolVersion?: string } };
	if (msg.id === undefined) return;
	switch (msg.method) {
		case "initialize":
			return send({
				jsonrpc: "2.0",
				id: msg.id,
				result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo-fixture", version: "1.0.0" } },
			});
		case "tools/list":
			return send({
				jsonrpc: "2.0",
				id: msg.id,
				result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] },
			});
		case "tools/call":
			return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: msg.params?.arguments?.text ?? "" }] } });
		case "ping":
			return send({ jsonrpc: "2.0", id: msg.id, result: {} });
		default:
			return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
	}
});
