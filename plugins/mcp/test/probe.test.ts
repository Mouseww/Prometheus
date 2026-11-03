import { createServer } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { probe } from "../src/index.ts";

const tools = [{ name: "echo", description: "echo back" }];
const reply = (m: { id?: number; method: string }) =>
	m.method === "initialize" ? { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } } } : m.method === "tools/list" ? { jsonrpc: "2.0", id: m.id, result: { tools } } : undefined;

const dir = mkdtempSync(join(tmpdir(), "mcp-"));
const script = join(dir, "server.mjs");
writeFileSync(
	script,
	`import {createInterface} from "node:readline";
const tools = ${JSON.stringify(tools)};
createInterface({input: process.stdin}).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") console.log(JSON.stringify({jsonrpc:"2.0", id:m.id, result:{protocolVersion:"2025-06-18", capabilities:{tools:{}}, serverInfo:{name:"fake", version:"1.0"}}}));
  else if (m.method === "tools/list") console.log(JSON.stringify({jsonrpc:"2.0", id:m.id, result:{tools}}));
});`,
);

const http = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const r = reply(JSON.parse(body));
		if (!r) return void res.writeHead(202).end();
		// Answer as an SSE stream, the harder of the two shapes.
		res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
	});
});
const port = await new Promise<number>((ok) => http.listen(0, "127.0.0.1", () => ok((http.address() as { port: number }).port)));
afterAll(() => void http.close());

describe("MCP probe without the PI packages", () => {
	it("talks to a stdio server", async () => {
		const r = await probe({ type: "stdio", command: process.execPath, args: [script] }, dir);
		expect(r.error ?? "").toBe("");
		expect(r).toMatchObject({ ok: true, server: "fake 1.0", tools: [{ name: "echo" }] });
	});
	it("talks to an HTTP server that answers with SSE", async () => {
		const r = await probe({ type: "http", url: `http://127.0.0.1:${port}/mcp` }, dir);
		expect(r).toMatchObject({ ok: true, tools: [{ name: "echo" }] });
	});
	it("reports a command that cannot start", async () => {
		const r = await probe({ type: "stdio", command: "definitely-not-a-command-xyz" }, dir);
		expect(r.ok).toBe(false);
	});
});
