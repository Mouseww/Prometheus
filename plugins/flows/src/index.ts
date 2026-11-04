import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import type { Flow, FlowInput, FlowRun, RunAccess } from "@prometheus/protocol";
import { FlowEngine, type FlowState } from "./engine.ts";
import { ensureStart, normalizeFlow } from "./graph.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const RANK: Record<RunAccess, number> = { readonly: 0, edits: 1, full: 2 };

export default definePlugin({
	name: "flows",
	version: "0.1.0",
	optional: true,
	async setup(ctx) {
		// Steps are unattended agent runs, which only the server host can start.
		if (ctx.host !== "server") return;

		const store = createJsonStore<FlowState>(join(ctx.dataDir, "flows.json"), () => ({ flows: [], runs: [] }));
		const engine = new FlowEngine({
			load: async () => {
				const s = await store.read();
				return { flows: s.flows ?? [], runs: s.runs ?? [] };
			},
			save: async (state) => void (await store.update(() => state)),
			workspaces: () => ctx.workspaces(),
			defaultCwd: async () => {
				// The personal assistant's home when it exists (it is kept out of the project list); otherwise a folder of our own.
				try {
					const o = (await ctx.callPlugin("assistant", "overview")) as { home?: string };
					if (o?.home && existsSync(o.home)) return o.home;
				} catch {
					// assistant plugin off
				}
				const dir = join(ctx.dataDir, "work");
				mkdirSync(dir, { recursive: true });
				return dir;
			},
			runAgent: (options) => ctx.runAgent(options),
			now: () => new Date(),
			changed: () => ctx.notifyChanged(),
			log: (m) => ctx.log.warn(m),
		});
		await engine.start();
		ctx.onDispose(() => engine.stop());

		const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
		const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
		const byRef = (ref: string): Flow => {
			const flows = engine.snapshot().flows;
			const found = flows.find((f) => f.id === ref) ?? flows.find((f) => f.name === ref);
			if (!found) throw new Error(`没有这个流程：${ref}`);
			return found;
		};

		ctx.tools.register({
			name: "flow_list",
			label: "列出流程",
			description: "List saved flows (agent orchestration SOPs) with their steps.",
			promptSnippet: "flow_list: list saved flows (custom SOPs)",
			parameters: Type.Object({}),
			async execute() {
				const list = engine.snapshot().flows;
				return text(
					list.length
						? list.map((f) => `${f.id} "${f.name}" ${f.description} — ${f.nodes.filter((n) => n.kind === "agent").map((n) => n.title).join(" → ")}`).join("\n")
						: "No flows.",
				);
			},
		});
		ctx.tools.register({
			name: "flow_run",
			label: "运行流程",
			description: "Run a saved flow to completion and return its final output. Steps never get more permission than this chat has. Can take many minutes.",
			promptSnippet: "flow_run: run a saved flow (custom SOP) with an input and get the result",
			parameters: Type.Object({ flow: Type.String({ description: "Flow id or name" }), input: Type.Optional(Type.String({ description: "Input text, available to steps as {{input}}" })) }),
			async execute(_id, params, signal, _update, toolCtx) {
				const flow = byRef(params.flow);
				const { done, runId } = await engine.startRun(flow.id, params.input ?? "", toolCtx.sessionId ?? "unknown", "agent", { cwd: toolCtx.cwd });
				signal?.addEventListener("abort", () => engine.cancel(runId), { once: true });
				const run = await done;
				const steps = flow.nodes.filter((n) => n.kind === "agent").map((n) => `- ${n.title}: ${run.nodes[n.id]?.status}`);
				const warning = run.warning ? `\n\n${run.warning}` : "";
				return text(`${run.status === "success" ? "Flow finished." : `Flow ${run.status}: ${run.error ?? ""}`}\n${steps.join("\n")}${warning}\n\n${run.output ?? ""}`);
			},
		});
		ctx.tools.register({
			name: "flow_create",
			label: "创建流程",
			description:
				"Save a flow (a DAG of agent steps). Provide `flow` as a JSON string: {name,description,nodes:[{id,kind:start|agent|condition|end,title,prompt?,access?,mode?,match?}],edges:[{from,to,branch?}]}. Exactly one start node. Prompts may use {{input}}, {{prev}}, {{nodeId}}. Step access is capped at this chat's permission: readonly reads only, edits writes files but cannot run commands, full also runs commands (a step that runs tests or scripts needs full).",
			promptSnippet: "flow_create: save a multi-step agent flow (custom SOP)",
			parameters: Type.Object({ flow: Type.String({ description: "Flow as a JSON object string" }) }),
			async execute(_id, params, _signal, _update, toolCtx) {
				const ws = (await ctx.workspaces()).find((w) => norm(w.path) === norm(toolCtx.cwd));
				const draft = ensureStart(normalizeFlow(JSON.parse(params.flow)));
				const cap = ctx.sessionAccess(toolCtx.sessionId ?? "unknown");
				for (const n of draft.nodes) if (n.access && RANK[n.access] > RANK[cap]) n.access = cap;
				const flow = await engine.create({ ...draft, workspaceId: ws && norm(ws.path) !== norm(await engine.homeDir()) ? ws.id : "" });
				return text(`Created flow ${flow.id} "${flow.name}" with ${flow.nodes.length} nodes. It can be edited in the Flows view.`);
			},
		});
		ctx.tools.register({
			name: "flow_delete",
			label: "删除流程",
			description: "Delete a saved flow by id.",
			promptSnippet: "flow_delete: remove a saved flow",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, params) {
				await engine.remove(params.id);
				return text(`Deleted flow ${params.id}.`);
			},
		});

		const toInput = (p: Record<string, unknown>): FlowInput => ({ ...normalizeFlow(p), workspaceId: str(p.workspaceId) });
		ctx.rpc("list", () => engine.snapshot());
		ctx.rpc("create", async (p): Promise<Flow> => engine.create(toInput(p)));
		ctx.rpc("update", async (p): Promise<Flow> => engine.update(str(p.id), toInput(p)));
		ctx.rpc("remove", async (p) => void (await engine.remove(str(p.id))));
		ctx.rpc("duplicate", async (p): Promise<Flow> => engine.duplicate(str(p.id)));
		ctx.rpc("generate", async (p): Promise<FlowInput> => engine.generate(str(p.description), str(p.workspaceId)));
		// Returns at once: the UI follows the run through the run list.
		ctx.rpc("run", async (p): Promise<{ runId: string }> => {
			// `access` is the level the user picked for this run; without it every step keeps its own.
			const asked = p.access === "readonly" || p.access === "edits" || p.access === "full" ? (p.access as RunAccess) : undefined;
			const { runId, done } = await engine.startRun(
				str(p.id),
				str(p.input),
				undefined,
				p.trigger === "automation" ? "automation" : "manual",
				typeof p.workspaceId === "string" ? { workspaceId: p.workspaceId } : undefined,
				asked,
			);
			void done.catch((err: unknown) => ctx.log.warn(`流程运行失败：${err instanceof Error ? err.message : err}`));
			return { runId };
		});
		// For callers that need the outcome (automations): the run record, or nothing once it has been trimmed away.
		ctx.rpc("get", (p) => engine.getRun(str(p.runId)) ?? null);
		ctx.rpc("cancel", (p) => ({ cancelled: engine.cancel(str(p.runId)) }));
		ctx.rpc("clearRuns", async () => void (await engine.clearRuns()));
	},
});

export type { FlowRun };
