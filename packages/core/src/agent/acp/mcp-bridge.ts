// A stdio MCP server that forwards to the tool bus over HTTP, for ACP agents that only accept stdio MCP servers.
// The script is written to the data directory on first use and run with this Node; the endpoint and its token reach
// it through the environment, never through arguments or files.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCRIPT = `// Prometheus tool bus bridge: stdio MCP <-> Streamable HTTP. Generated; do not edit.
const url = process.env.PROMETHEUS_MCP_URL;
const token = process.env.PROMETHEUS_MCP_TOKEN;
if (!url || !token) { process.stderr.write("PROMETHEUS_MCP_URL and PROMETHEUS_MCP_TOKEN are required\\n"); process.exit(2); }
let session;
let buffer = "";
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token };
    if (session) headers["mcp-session-id"] = session;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(msg) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) session = sid;
    const text = await res.text();
    if (!text.trim()) return;
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      for (const block of text.split(/\\r?\\n\\r?\\n/)) {
        const data = block.split(/\\r?\\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\\n");
        if (data) { try { out(JSON.parse(data)); } catch {} }
      }
      return;
    }
    out(JSON.parse(text));
  } catch (err) {
    if (msg && msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Prometheus tool bus unreachable: " + (err && err.message ? err.message : String(err)) } });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) void forward(line);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** Path of the bridge script, written (or refreshed) under `<dataDir>/runtimes/acp`. */
export async function mcpBridgeScript(dataDir: string): Promise<string> {
	const dir = join(dataDir, "runtimes", "acp");
	const file = join(dir, "mcp-bridge.cjs");
	const current = await readFile(file, "utf8").catch(() => "");
	if (current !== SCRIPT) {
		await mkdir(dir, { recursive: true });
		await writeFile(file, SCRIPT, "utf8");
	}
	return file;
}
