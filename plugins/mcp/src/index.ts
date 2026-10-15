import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import type { McpProbeResult, McpServerInfo, McpServerSpec } from "@prometheus/protocol";
import { fromPiConfig, mergeSpec, NAME_PATTERN, parseSpec, redactSpec, toPiConfig } from "./spec.ts";

interface State {
	servers: Record<string, McpServerSpec>;
}

const PROBE_TIMEOUT_MS = 20_000;

function expandEnv(value: string): string {
	return value.replace(/\$\{([A-Za-z_]\w*)\}/g, (_, name: string) => process.env[name] ?? "");
}

function expandRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	return record && Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expandEnv(v)]));
}

function transportFor(spec: McpServerSpec, cwd: string): McpTransport {
	if (spec.type === "http") return new StreamableHttpTransport({ url: spec.url ?? "", headers: expandRecord(spec.headers), openGetStream: false });
	return new StdioTransport({ command: spec.command ?? "", args: spec.args, env: expandRecord(spec.env), cwd: spec.cwd ?? cwd, stderr: "pipe" });
}

/** Connect once, list tools, disconnect: lets users check a server before an agent depends on it. */
export async function probe(spec: McpServerSpec, cwd: string): Promise<McpProbeResult> {
	const started = performance.now();
	const client = new McpClient({ name: "prometheus", version: "0.1.0" });
	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	try {
		const init = await Promise.race([
			client.connect(transportFor(spec, cwd)),
			new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("连接超时")))),
		]);
		const tools = init.capabilities.tools ? await client.listTools({ signal }) : [];
		return {
			ok: true,
			latencyMs: Math.round(performance.now() - started),
			server: `${init.serverInfo.name} ${init.serverInfo.version}`,
			tools: tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 300) })),
		};
	} catch (err) {
		return { ok: false, latencyMs: Math.round(performance.now() - started), tools: [], error: err instanceof Error ? err.message : String(err) };
	} finally {
		await client.close().catch(() => {});
	}
}

function readPiServers(agentDir: string): Record<string, McpServerSpec> {
	const path = join(agentDir, "mcp.json");
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> };
		const out: Record<string, McpServerSpec> = {};
		for (const [name, entry] of Object.entries(raw.mcpServers ?? {})) {
			const spec = fromPiConfig(entry);
			if (spec) out[name] = spec;
		}
		return out;
	} catch {
		return {};
	}
}

function requireName(value: unknown): string {
	if (typeof value !== "string" || !NAME_PATTERN.test(value)) throw new Error("服务器名只能包含字母、数字、- 和 _，且不超过 48 个字符");
	return value;
}

export default definePlugin({
	name: "mcp",
	version: "0.1.0",
	async setup(ctx) {
		const store = createJsonStore<State>(join(ctx.dataDir, "servers.json"), () => ({ servers: {} }));
		await store.read();

		// Servers are handed to PI's MCP extension, which owns connections, OAuth and tool exposure.
		ctx.extension(async (pi) => {
			const { servers } = await store.read();
			for (const [name, spec] of Object.entries(servers)) {
				if (spec.enabled === false) continue;
				pi.registerMcpServer(name, toPiConfig(spec) as unknown as Parameters<typeof pi.registerMcpServer>[1]);
			}
		});

		ctx.rpc("list", async (): Promise<McpServerInfo[]> => {
			const { servers } = await store.read();
			const own = Object.entries(servers).map(([name, spec]) => ({ name, spec: redactSpec(spec), source: "prometheus" as const }));
			const pi = Object.entries(readPiServers(ctx.agentDir))
				.filter(([name]) => !servers[name])
				.map(([name, spec]) => ({ name, spec: redactSpec(spec), source: "pi" as const }));
			return [...own, ...pi].sort((a, b) => a.name.localeCompare(b.name));
		});

		ctx.rpc("save", async (params) => {
			const name = requireName(params.name);
			const previous = params.previousName === undefined ? undefined : requireName(params.previousName);
			const spec = parseSpec(params.spec);
			await store.update((state) => {
				if (name !== previous && state.servers[name]) throw new Error(`服务器已存在：${name}`);
				const merged = mergeSpec(spec, state.servers[previous ?? name]);
				if (previous && previous !== name) delete state.servers[previous];
				state.servers[name] = merged;
				return state;
			});
			await ctx.reloadSessions();
			return null;
		});

		ctx.rpc("toggle", async (params) => {
			const name = requireName(params.name);
			await store.update((state) => {
				const spec = state.servers[name];
				if (!spec) throw new Error(`服务器不存在：${name}`);
				spec.enabled = params.enabled !== false;
				return state;
			});
			await ctx.reloadSessions();
			return null;
		});

		ctx.rpc("delete", async (params) => {
			const name = requireName(params.name);
			await store.update((state) => {
				delete state.servers[name];
				return state;
			});
			await ctx.reloadSessions();
			return null;
		});

		ctx.rpc("probe", async (params) => {
			const { servers } = await store.read();
			if (params.spec !== undefined) {
				const prev = typeof params.name === "string" ? servers[params.name] : undefined;
				return probe(mergeSpec(parseSpec(params.spec), prev), ctx.cwd);
			}
			const name = requireName(params.name);
			const spec = servers[name] ?? readPiServers(ctx.agentDir)[name];
			if (!spec) throw new Error(`服务器不存在：${name}`);
			return probe(spec, ctx.cwd);
		});
	},
});
