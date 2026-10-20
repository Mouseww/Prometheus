import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import type { AutomationInput, AutomationRun, AutomationTask } from "@prometheus/protocol";
import { AutomationEngine, type AutomationState } from "./engine.ts";
import { describeSchedule } from "./schedule.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");

function toInput(p: Record<string, unknown>): AutomationInput {
	const model = p.model && typeof p.model === "object" ? (p.model as Record<string, unknown>) : undefined;
	return {
		name: str(p.name),
		prompt: str(p.prompt),
		workspaceId: str(p.workspaceId),
		schedule: p.schedule as AutomationInput["schedule"],
		access: str(p.access) as AutomationInput["access"],
		enabled: p.enabled !== false,
		...(model && str(model.provider) && str(model.id) ? { model: { provider: str(model.provider), id: str(model.id) } } : {}),
	};
}

export default definePlugin({
	name: "automations",
	version: "0.1.0",
	optional: true,
	async setup(ctx) {
		// Unattended runs need the in-process session host; the terminal build has none, so it just stays inert there.
		if (ctx.host !== "server") return;

		const store = createJsonStore<AutomationState>(join(ctx.dataDir, "automations.json"), () => ({ tasks: [], runs: [] }));
		const engine = new AutomationEngine({
			load: async () => {
				const s = await store.read();
				return { tasks: s.tasks ?? [], runs: s.runs ?? [] };
			},
			save: async (state) => void (await store.update(() => state)),
			workspaces: () => ctx.workspaces(),
			runAgent: (options) => ctx.runAgent(options),
			now: () => new Date(),
			changed: () => ctx.notifyChanged(),
			log: (m) => ctx.log.warn(m),
		});
		await engine.start();
		ctx.onDispose(() => engine.stop());

		const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
		const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

		ctx.extension((pi) => {
			pi.registerTool({
				name: "automation_create",
				label: "创建自动化任务",
				description:
					"Create a persistent scheduled automation that runs the agent unattended in the current workspace (shown in the Automations view). schedule: {type:'interval',minutes} (5..10080), {type:'daily',time:'HH:MM',days?:[0-6]} in local time, or {type:'once',at:ISO datetime}. access: readonly (default) | edits | full.",
				promptSnippet: "automation_create: schedule a recurring or one-off unattended agent task",
				parameters: Type.Object({
					name: Type.String({ description: "Short task name" }),
					prompt: Type.String({ description: "Complete, self-contained instruction the agent will run each time" }),
					schedule: Type.Union([
						Type.Object({ type: Type.Literal("interval"), minutes: Type.Integer() }),
						Type.Object({ type: Type.Literal("daily"), time: Type.String({ description: "HH:MM local" }), days: Type.Optional(Type.Array(Type.Integer())) }),
						Type.Object({ type: Type.Literal("once"), at: Type.String({ description: "ISO 8601 datetime" }) }),
					]),
					access: Type.Optional(Type.Union([Type.Literal("readonly"), Type.Literal("edits"), Type.Literal("full")])),
				}),
				async execute(_id, params, _signal, _update, toolCtx) {
					const ws = (await ctx.workspaces()).find((w) => norm(w.path) === norm(toolCtx.cwd));
					if (!ws) throw new Error("当前目录不是已添加的工作区，请先在侧栏添加");
					const task = await engine.create({
						name: params.name,
						prompt: params.prompt,
						workspaceId: ws.id,
						schedule: params.schedule as AutomationInput["schedule"],
						access: params.access ?? "readonly",
						enabled: true,
					});
					return text(`Created automation ${task.id} "${task.name}" (${describeSchedule(task.schedule)}), next run ${task.nextRunAt ?? "none"}.`);
				},
			});
			pi.registerTool({
				name: "automation_list",
				label: "列出自动化任务",
				description: "List scheduled automations.",
				promptSnippet: "automation_list: list scheduled automations",
				parameters: Type.Object({}),
				async execute() {
					const list = engine.snapshot().tasks;
					return text(list.length ? list.map((t) => `${t.id} ${t.enabled ? "on " : "off"} ${t.name} [${describeSchedule(t.schedule)}] next=${t.nextRunAt ?? "-"}`).join("\n") : "No automations.");
				},
			});
			pi.registerTool({
				name: "automation_delete",
				label: "删除自动化任务",
				description: "Delete a scheduled automation by id.",
				promptSnippet: "automation_delete: remove a scheduled automation",
				parameters: Type.Object({ id: Type.String() }),
				async execute(_id, params) {
					await engine.remove(params.id);
					return text(`Deleted automation ${params.id}.`);
				},
			});
		});

		const tasks = () => engine.snapshot().tasks.map((t) => ({ ...t, scheduleText: describeSchedule(t.schedule) }));
		ctx.rpc("list", () => {
			const s = engine.snapshot();
			return { tasks: tasks(), runs: s.runs };
		});
		ctx.rpc("create", async (p): Promise<AutomationTask> => engine.create(toInput(p)));
		ctx.rpc("update", async (p): Promise<AutomationTask> => engine.update(str(p.id), toInput(p)));
		ctx.rpc("setEnabled", async (p): Promise<AutomationTask> => engine.setEnabled(str(p.id), p.enabled === true));
		ctx.rpc("remove", async (p) => void (await engine.remove(str(p.id))));
		// Returns at once: a run can take many minutes and the UI follows it through the run list.
		ctx.rpc("runNow", (p): { started: true } => {
			const id = str(p.id);
			void engine.runNow(id).catch((err: unknown) => ctx.log.warn(`手动运行失败：${err instanceof Error ? err.message : err}`));
			return { started: true };
		});
		ctx.rpc("cancel", (p) => ({ cancelled: engine.cancel(str(p.id)) }));
		ctx.rpc("clearRuns", async () => void (await engine.clearRuns()));
	},
});

export type { AutomationRun };
