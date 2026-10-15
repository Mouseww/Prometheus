import { readFile } from "node:fs/promises";
import type { UsageStats, UsageTotals } from "@prometheus/protocol";

const empty = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 });

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function add(into: UsageTotals, u: Record<string, unknown>): void {
	into.input += num(u.input);
	into.output += num(u.output);
	into.cacheRead += num(u.cacheRead);
	into.cacheWrite += num(u.cacheWrite);
	into.cost += num((u.cost as { total?: unknown } | undefined)?.total);
	into.requests += 1;
}

const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Sums provider-reported usage over session JSONL files; entries older than `days` (0 = all) are skipped. */
export async function collectUsage(files: string[], days: number, now = new Date()): Promise<UsageStats> {
	const since = days > 0 ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime() : 0;
	const totals = empty();
	const models = new Map<string, UsageTotals & { provider: string; model: string }>();
	const daily = new Map<string, UsageTotals & { date: string }>();
	let sessions = 0;

	for (const file of files) {
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		let touched = false;
		for (const line of text.split("\n")) {
			// Cheap pre-filter: most lines are message bodies without usage.
			if (!line.includes('"usage"')) continue;
			let entry: { timestamp?: string; message?: Record<string, unknown>; usage?: Record<string, unknown>; provider?: string; model?: string };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const msg = entry.message;
			const isAssistant = msg?.role === "assistant";
			const usage = (isAssistant ? msg.usage : entry.usage) as Record<string, unknown> | undefined;
			if (!usage || typeof usage !== "object") continue;
			const at = new Date(entry.timestamp ?? 0);
			if (Number.isNaN(at.getTime()) || at.getTime() < since) continue;

			const provider = String((isAssistant ? msg.provider : entry.provider) ?? "unknown");
			const model = String((isAssistant ? msg.model : entry.model) ?? "unknown");
			const key = `${provider}/${model}`;
			const day = localDay(at);
			const m = models.get(key) ?? { ...empty(), provider, model };
			const d = daily.get(day) ?? { ...empty(), date: day };
			for (const bucket of [totals, m, d]) add(bucket, usage);
			models.set(key, m);
			daily.set(day, d);
			touched = true;
		}
		if (touched) sessions += 1;
	}

	return {
		days,
		sessions,
		totals,
		byModel: [...models.values()].sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output)),
		byDay: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
	};
}
