import type { AgentRunOptions, AgentRunResult } from "@prometheus/plugin-sdk";

export interface BriefingSettings {
	enabled: boolean;
	/** Local time, "HH:MM". */
	time: string;
	/** Local date ("YYYY-MM-DD") of the last briefing that ran, so one day gets one briefing. */
	lastDate?: string;
}

export const DEFAULT_BRIEFING: BriefingSettings = { enabled: false, time: "08:30" };

export const BRIEFING_PROMPT = `现在是每日简报时间，用户不在场。请做一份简短的每日简报（不超过 300 字）：
1. 先看 notes/ 里最近的笔记，列出还没做完的事和接下来的安排。
2. 如果笔记里提到了某些项目，用 assistant_projects 和 assistant_delegate 只读地了解一下它们最近的进展（每个项目一句话），不要改任何东西。
3. 最后给出今天值得先做的一到三件事。
用中文，先说结论。没有可写的内容就直说没有，不要编造。`;

export function validTime(time: unknown): time is string {
	return typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function localDate(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Due once the day's time has passed and today's briefing has not run. A late start catches up the same day. */
export function isDue(s: BriefingSettings, now: Date): boolean {
	if (!s.enabled || !validTime(s.time) || s.lastDate === localDate(now)) return false;
	const [h, m] = s.time.split(":").map(Number) as [number, number];
	return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
}

export interface BriefingDeps {
	load(): Promise<BriefingSettings>;
	save(s: BriefingSettings): Promise<void>;
	now(): Date;
	/** Runs the agent in the assistant's home, read-only. */
	run(options: AgentRunOptions): Promise<AgentRunResult>;
	/** Stores the briefing where the user will find it (a note). */
	publish(date: string, text: string): Promise<void>;
	changed(): void;
	log(message: string): void;
	homeDir: string;
}

/** One check; the plugin calls it on a timer. Returns whether a briefing ran. */
export function createBriefing(deps: BriefingDeps): () => Promise<boolean> {
	let running = false;
	return async () => {
		if (running) return false;
		const s = await deps.load();
		const now = deps.now();
		if (!isDue(s, now)) return false;
		running = true;
		const date = localDate(now);
		try {
			// Marked before running: a briefing that fails is not retried in a loop all day.
			await deps.save({ ...s, lastDate: date });
			const r = await deps.run({ cwd: deps.homeDir, prompt: BRIEFING_PROMPT, name: `每日简报 ${date}`, access: "readonly", timeoutMs: 10 * 60_000 });
			if (r.status === "success" && r.text.trim()) await deps.publish(date, r.text.trim());
			else deps.log(`briefing ${date}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
			deps.changed();
			return true;
		} catch (err) {
			deps.log(`briefing ${date} failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			running = false;
		}
	};
}
