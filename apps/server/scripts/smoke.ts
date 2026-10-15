// Smoke test for a running Prometheus server: node scripts/smoke.ts [port]
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const port = process.argv[2] ?? "7420";
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let seq = 0;
const pending = new Map<string, (frame: { ok: boolean; data?: unknown; error?: string }) => void>();

function rpc(method: string, params: unknown = {}): Promise<unknown> {
	const id = `r${++seq}`;
	ws.send(JSON.stringify({ type: "rpc", id, method, params }));
	return new Promise((resolve, reject) => {
		pending.set(id, (f) => (f.ok ? resolve(f.data) : reject(new Error(f.error))));
	});
}

ws.on("message", (raw) => {
	const frame = JSON.parse(raw.toString());
	if (frame.type === "response") pending.get(frame.id)?.(frame);
});

ws.on("open", async () => {
	try {
		console.log("host.info", await rpc("host.info"));
		console.log("plugin.list", JSON.stringify(await rpc("plugin.list")));
		console.log("kb.stores", await rpc("kb.stores"));
		const models = (await rpc("model.list")) as unknown[];
		console.log("model.list count", models.length);
		const snap = (await rpc("session.create", {})) as { id: string; model: unknown };
		console.log("session.create", snap.id, snap.model);
		const tools = (await rpc("tools.list", { sessionId: snap.id })) as { name: string }[];
		console.log("tools", tools.map((t) => t.name).join(","));
		const cmds = (await rpc("commands.list", { sessionId: snap.id })) as unknown[];
		console.log("commands count", cmds.length);
		console.log("stats", await rpc("session.stats", { sessionId: snap.id }));

				const dirs = (await rpc("fs.dirs", {})) as { path: string; dirs: unknown[]; roots: string[] };
				console.log("fs.dirs", dirs.path, dirs.dirs.length, dirs.roots.join(","));
				const workspaces = (await rpc("workspace.list")) as { id: string; path: string }[];
				const ws = workspaces.find((w) => w.id === (snap as unknown as { workspaceId: string }).workspaceId);
				console.log("workspace.list", workspaces.length, ws?.path);
				if (!ws) throw new Error("session workspace missing");
				const settings = (await rpc("settings.get")) as { autoCompaction: boolean };
				console.log("settings.get", settings);
				await rpc("settings.set", { autoCompaction: settings.autoCompaction });
				const throwaway = (await rpc("session.create", { cwd: ws.path })) as { id: string };
				await rpc("session.archive", { sessionId: throwaway.id, archived: true });
				await rpc("session.delete", { sessionId: throwaway.id });
				console.log("session.archive/delete ok");
		const plug = (plugin: string, method: string, params: Record<string, unknown> = {}) => rpc("plugin.call", { plugin, method, params });

		const echo = { type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("./mcp-echo.ts", import.meta.url))], exposure: "direct" };
		const probe = (await plug("mcp", "probe", { spec: echo })) as { ok: boolean; server?: string; tools: { name: string }[]; error?: string };
		console.log("mcp.probe", probe.ok, probe.server, probe.tools.map((t) => t.name), probe.error ?? "");
		if (!probe.ok) throw new Error("mcp probe failed");
		await plug("mcp", "save", { name: "smoke-echo", spec: echo });
		console.log("mcp.list", ((await plug("mcp", "list")) as { name: string }[]).map((s) => s.name));

		await plug("skills", "create", { name: "smoke-skill", description: "Smoke test skill", body: "# Smoke" });
		const skills = (await plug("skills", "list")) as { name: string; scope: string }[];
		console.log("skills.list", skills.filter((s) => s.scope === "prometheus").map((s) => s.name));

		const mem = (await plug("memory", "add", { content: "冒烟测试：用户偏好 pnpm", tags: ["smoke"], scope: "user" })) as { id: string };
		console.log("memory.add", mem.id);

		// MCP servers connect in the background after reload; poll until the tool shows up.
		let after: { name: string }[] = [];
		for (let i = 0; i < 40 && !after.some((t) => t.name.startsWith("mcp__")); i++) {
			await new Promise((r) => setTimeout(r, 250));
			after = (await rpc("tools.list", { sessionId: snap.id })) as { name: string }[];
		}
		console.log("tools after reload", after.map((t) => t.name).filter((n) => n.startsWith("memory_") || n.startsWith("mcp__")).join(","));
		if (!after.some((t) => t.name === "mcp__smoke_echo__echo")) throw new Error("MCP tool not registered");
		const cmds2 = (await rpc("commands.list", { sessionId: snap.id })) as { name: string }[];
		console.log("skill command present", cmds2.some((c) => c.name === "skill:smoke-skill"));

		await plug("mcp", "delete", { name: "smoke-echo" });
		await plug("skills", "delete", { name: "smoke-skill" });
		await plug("memory", "delete", { id: mem.id });
		await rpc("session.close", { sessionId: snap.id });
		console.log("SMOKE OK");
	} catch (err) {
		console.error("SMOKE FAIL", err);
		process.exitCode = 1;
	}
	ws.close();
});
