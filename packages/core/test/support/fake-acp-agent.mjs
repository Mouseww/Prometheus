// A scripted ACP agent for tests: JSON-RPC 2.0 over stdio, driven by keywords in the prompt.
// FAKE_ACP_HTTP=0 makes it announce stdio-only MCP support (then it reaches the tool bus through Prometheus' bridge).
import { spawn } from "node:child_process";

const httpMcp = process.env.FAKE_ACP_HTTP !== "0";
let seq = 0;
const pending = new Map();
const sessions = new Map();
let buffer = "";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const request = (method, params) =>
	new Promise((resolve) => {
		const id = `a${++seq}`;
		pending.set(id, resolve);
		send({ id, method, params });
	});
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls a tool of the Prometheus MCP server the client gave us (HTTP, or the stdio bridge). */
async function callTool(server, name, args) {
	const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
	if (server.type === "http") {
		const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
		for (const h of server.headers ?? []) headers[h.name] = h.value;
		const res = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(body) });
		const text = await res.text();
		const data = text.includes("data:") ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).at(-1)) : JSON.parse(text);
		return data.result;
	}
	const env = { ...process.env };
	for (const e of server.env ?? []) env[e.name] = e.value;
	const child = spawn(server.command, server.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
	child.stdout.setEncoding("utf8");
	let out = "";
	const answer = new Promise((resolve) => {
		child.stdout.on("data", (d) => {
			out += d;
			const line = out.split("\n").find((l) => l.includes('"id":1'));
			if (line) resolve(JSON.parse(line).result);
		});
	});
	child.stdin.write(`${JSON.stringify(body)}\n`);
	const result = await answer;
	child.stdin.end();
	return result;
}

async function prompt(id, params) {
	const s = sessions.get(params.sessionId);
	const text = params.prompt.filter((b) => b.type === "text").map((b) => b.text).join("");
	const images = params.prompt.filter((b) => b.type === "image").length;
	s.cancelled = false;
	const sid = params.sessionId;
	if (text.includes("echo context")) {
		update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `PROMPT:${JSON.stringify(text)} IMAGES:${images} MODE:${s.mode} MODEL:${s.model}` } });
	} else if (text.includes("run bash")) {
		update(sid, { sessionUpdate: "tool_call", toolCallId: "t-bash", title: "touch made.txt", kind: "execute", status: "pending", rawInput: { command: "touch made.txt" } });
		const answer = await request("session/request_permission", { sessionId: sid, toolCall: { toolCallId: "t-bash" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
		const ok = answer.outcome?.outcome === "selected" && answer.outcome.optionId === "yes";
		update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-bash", status: ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: ok ? "hi\n" : "denied by user" } }] });
		update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ok ? "ran it" : "could not run it" } });
	} else if (text.includes("write file")) {
		update(sid, { sessionUpdate: "tool_call", toolCallId: "t-write", title: "Write a.txt", kind: "edit", status: "pending", locations: [{ path: "/tmp/a.txt" }], content: [{ type: "diff", path: "/tmp/a.txt", oldText: null, newText: "new content" }] });
		const answer = await request("session/request_permission", { sessionId: sid, toolCall: { toolCallId: "t-write" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
		const ok = answer.outcome?.optionId === "yes";
		update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-write", status: ok ? "completed" : "failed" });
	} else if (text.includes("use tool")) {
		update(sid, { sessionUpdate: "tool_call", toolCallId: "t-mcp", title: "echo_tool (prometheus MCP Server)", kind: "other", status: "pending" });
		const answer = await request("session/request_permission", { sessionId: sid, toolCall: { toolCallId: "t-mcp" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
		if (answer.outcome?.optionId !== "yes") throw new Error("our own tool was not allowed");
		update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-mcp", status: "in_progress" });
		const server = s.mcpServers.find((m) => m.name === "prometheus");
		const result = await callTool(server, "echo_tool", { text: "ping" });
		update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-mcp", status: "completed", content: [{ type: "content", content: { type: "text", text: result.content[0].text } }] });
		update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool done" } });
	} else if (text.includes("make a plan")) {
		update(sid, { sessionUpdate: "plan", entries: [{ content: "first", priority: "high", status: "completed" }, { content: "second", priority: "low", status: "in_progress" }] });
		update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "planned" } });
	} else if (text.includes("slow")) {
		for (let i = 0; i < 100 && !s.cancelled; i++) {
			update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
			await sleep(50);
		}
		if (s.cancelled) return send({ id, result: { stopReason: "cancelled" } });
	} else if (text.includes("crash")) {
		process.exit(3);
	} else {
		update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about it" } });
		update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " } });
		update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
	}
	send({ id, result: { stopReason: "end_turn" } });
}

function handle(msg) {
	if (msg.id !== undefined && !msg.method) {
		pending.get(msg.id)?.(msg.result ?? {});
		pending.delete(msg.id);
		return;
	}
	const { id, method, params } = msg;
	switch (method) {
		case "initialize":
			return send({ id, result: { protocolVersion: 1, agentInfo: { name: "fake", title: "Fake", version: "9.9.9" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: httpMcp, sse: false } }, authMethods: [] } });
		case "session/new": {
			const sessionId = `s${sessions.size + 1}`;
			sessions.set(sessionId, { mcpServers: params.mcpServers, mode: "auto", model: "m1" });
			send({ id, result: { sessionId, models: { currentModelId: "m1", availableModels: [{ modelId: "m1", name: "Model One" }, { modelId: "m2", name: "Model Two" }] }, modes: { currentModeId: "auto", availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] } } });
			update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compress", description: "Compress the context" }] });
			return;
		}
		case "session/load": {
			sessions.set(params.sessionId, { mcpServers: params.mcpServers, mode: "auto", model: "m1" });
			update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "<prometheus-context>\nhidden\n</prometheus-context>\n\n" } });
			update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } });
			update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } });
			return send({ id, result: {} });
		}
		case "session/set_mode":
			sessions.get(params.sessionId).mode = params.modeId;
			return send({ id, result: {} });
		case "session/set_model":
			sessions.get(params.sessionId).model = params.modelId;
			return send({ id, result: {} });
		case "session/prompt":
			return void prompt(id, params).catch((err) => send({ id, error: { code: -32603, message: String(err.message ?? err) } }));
		case "session/cancel":
			if (sessions.has(params.sessionId)) sessions.get(params.sessionId).cancelled = true;
			return;
		default:
			if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, i).trim();
		buffer = buffer.slice(i + 1);
		if (line) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => process.exit(0));
