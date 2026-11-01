// End-to-end through a real server: plugin.watch, binary frames over the WebSocket, and the browser RPCs.
// Usage: node plugins/browser/test/server-stream.ts
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBinaryFrame } from "@prometheus/protocol";
import { startSite } from "./fixtures.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "pm-stream-home-"));
const PORT = 17900 + Math.floor(Math.random() * 90);
const site = await startSite();
const t0 = Date.now();
const server = spawn(process.execPath, [join(root, "apps/server/src/main.ts")], {
	env: { ...process.env, PROMETHEUS_PORT: String(PORT), PROMETHEUS_HOME: home, PROMETHEUS_HOST: "127.0.0.1", PROMETHEUS_TOKEN: "", PROMETHEUS_PARENT_WATCH: "" },
	stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 160 && !log.includes("PROMETHEUS_READY"); i++) await new Promise((r) => setTimeout(r, 250));
console.log(`server ready in ${Date.now() - t0} ms`);

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.binaryType = "arraybuffer";
let seq = 0;
const pending = new Map<string, (f: { ok: boolean; data?: unknown; error?: string }) => void>();
let frames = 0;
let bytes = 0;
const states: string[] = [];
ws.addEventListener("message", (ev: MessageEvent) => {
	if (ev.data instanceof ArrayBuffer) {
		const f = decodeBinaryFrame(new Uint8Array(ev.data));
		if (f?.header.type === "plugin.event") {
			frames++;
			bytes += f.payload.length;
		}
		return;
	}
	const frame = JSON.parse(String(ev.data));
	if (frame.type === "response") pending.get(frame.id)?.(frame);
	if (frame.type === "plugin.event" && frame.data?.k === "state") states.push(`${frame.data.state.status}:${frame.data.state.tabs.map((t: { url: string }) => t.url).join(",")}`);
});
await new Promise((r) => ws.addEventListener("open", r));
const rpc = (method: string, params: unknown = {}) => {
	const id = `r${++seq}`;
	const t = Date.now();
	ws.send(JSON.stringify({ type: "rpc", id, method, params }));
	return new Promise<unknown>((resolve, reject) =>
		pending.set(id, (f) => {
			console.log(`  ${method} ${Date.now() - t} ms`);
			f.ok ? resolve(f.data) : reject(new Error(f.error));
		}),
	);
};
const call = (method: string, params: Record<string, unknown> = {}) => rpc("plugin.call", { plugin: "browser", method, params });

try {
	const plugins = (await rpc("plugin.list")) as { name: string; status: string; error?: string }[];
	console.log("browser plugin:", plugins.find((p) => p.name === "browser"));
	ws.send(JSON.stringify({ type: "plugin.watch", plugin: "browser", topic: "view" }));
	await call("start");
	const st = (await call("state")) as { state: { tabs: { id: string }[]; active: string } };
	await call("viewport", { width: 1000, height: 700, dpr: 1 });
	await call("navigate", { tab: st.state.active, url: `${site.url}/form` });
	await new Promise((r) => setTimeout(r, 1500));
	await call("input", { tab: st.state.active, events: [{ k: "wheel", x: 100, y: 100, dx: 0, dy: 300 }] });
	await new Promise((r) => setTimeout(r, 800));
	console.log(`frames over the socket: ${frames}, ${(bytes / 1024).toFixed(0)} KB`);
	console.log("states:", [...new Set(states)].slice(-4));
	ws.send(JSON.stringify({ type: "plugin.unwatch", plugin: "browser", topic: "view" }));
	const before = frames;
	await call("navigate", { tab: st.state.active, url: site.url });
	await new Promise((r) => setTimeout(r, 1200));
	console.log(`frames after unwatch: ${frames - before} (expect 0)`);
	if (frames < 1 || frames - before !== 0) process.exitCode = 1;
} finally {
	ws.close();
	server.kill();
	site.server.close();
}
