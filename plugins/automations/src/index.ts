import { join } from "node:path";
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
