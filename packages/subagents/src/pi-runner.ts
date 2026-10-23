import { createAgentSession, DefaultResourceLoader, type ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SubagentStep } from "@prometheus/protocol";
import type { RunHooks, RunJob } from "./types.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];
/** Tools a PI child can be given. Plugin tools live in the parent's extensions and do not reach a child. */
export const PI_CHILD_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `provider/model:level` → the pieces. A trailing `:level` is only a level when it is one. */
export function splitModel(spec: string): { model: string; level?: Level } {
	const i = spec.lastIndexOf(":");
	const tail = i >= 0 ? spec.slice(i + 1) : "";
	if (i >= 0 && (LEVELS as readonly string[]).includes(tail)) return { model: spec.slice(0, i), level: tail as Level };
	return { model: spec };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: arr(content)
				.map((b) => str(rec(b)?.text))
				.filter(Boolean)
				.join("\n");

const argText = (args: unknown): string => {
	const o = rec(args);
	if (!o) return "";
	return str(o.command) || str(o.path) || str(o.file_path) || str(o.pattern) || clip(JSON.stringify(o), 300);
};

export interface PiRunnerDeps {
	modelRuntime: ModelRuntime;
	agentDir: string;
	/** The chat's current model, for agents that do not name one. */
	parentModel: () => string | undefined;
	parentThinking: () => Level | undefined;
}

export function createPiRunner(deps: PiRunnerDeps) {
	const find = (spec: string) => {
		const all = deps.modelRuntime.getModels();
		return all.find((m) => `${m.provider}/${m.id}` === spec) ?? all.find((m) => m.id === spec);
	};

	return async function runPi(job: RunJob, hooks: RunHooks, signal: AbortSignal): Promise<string> {
		const requested = job.model?.trim() || deps.parentModel() || "";
		const { model: modelSpec, level } = splitModel(requested);
		const model = modelSpec ? find(modelSpec) : undefined;
		if (modelSpec && !model) throw new Error(`找不到模型 ${modelSpec}。请到子代理设置里重新选择，或留空以继承当前对话的模型`);
		if (model) hooks.model(`${model.provider}/${model.id}`);
		const thinking = (job.thinking?.trim() as Level | undefined) || level || deps.parentThinking();

		const def = job.def;
		const tools = def.tools.length ? def.tools.filter((t) => PI_CHILD_TOOLS.includes(t)) : undefined;
		const loader = new DefaultResourceLoader({
			cwd: job.cwd,
			agentDir: deps.agentDir,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noSkills: !def.inheritSkills,
			noContextFiles: !def.inheritProject,
			...(def.prompt.trim() ? (def.mode === "append" ? { appendSystemPrompt: [def.prompt] } : { systemPrompt: def.prompt }) : {}),
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: job.cwd,
			agentDir: deps.agentDir,
			modelRuntime: deps.modelRuntime,
			sessionManager: SessionManager.inMemory(job.cwd),
			settingsManager: SettingsManager.create(job.cwd, deps.agentDir),
			resourceLoader: loader,
			...(model ? { model } : {}),
			...(thinking && (LEVELS as readonly string[]).includes(thinking) ? { thinkingLevel: thinking } : {}),
			...(tools ? { tools } : {}),
		});

		const open = new Map<string, SubagentStep>();
		const off = session.subscribe((event) => {
			const e = event as unknown as Rec;
			if (e.type === "message_end") {
				const m = rec(e.message);
				if (m?.role !== "assistant") return;
				for (const b of arr(m.content)) {
					const block = rec(b);
					if (block?.type === "thinking" && str(block.thinking).trim()) hooks.step({ kind: "thinking", text: str(block.thinking) });
					else if (block?.type === "text" && str(block.text).trim()) hooks.step({ kind: "text", text: str(block.text) });
				}
				const total = Number(rec(m.usage)?.totalTokens);
				if (total) hooks.tokens(total);
			} else if (e.type === "tool_execution_start") {
				const step: SubagentStep = { kind: "tool", text: "", tool: str(e.toolName), args: argText(e.args) };
				open.set(str(e.toolCallId), step);
				hooks.step(step);
				hooks.tool(str(e.toolName));
			} else if (e.type === "tool_execution_end") {
				const step = open.get(str(e.toolCallId));
				if (step) {
					step.result = clip(textOf(rec(e.result)?.content), 4000);
					if (e.isError === true) step.isError = true;
					hooks.touch();
				}
			}
		});
		const abort = () => void session.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			if (signal.aborted) throw new Error("已停止");
			await session.prompt(job.task);
			if (signal.aborted) throw new Error("已停止");
			const out = session.getLastAssistantText()?.trim();
			const last = rec([...session.messages].reverse().find((m) => rec(m)?.role === "assistant"));
			// A failed model call ends the turn with an error message instead of throwing.
			if (last?.stopReason === "error") throw new Error(str(last.errorMessage) || "模型请求失败");
			return out ?? "";
		} finally {
			signal.removeEventListener("abort", abort);
			off();
			session.dispose();
		}
	};
}
