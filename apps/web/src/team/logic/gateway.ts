// Form helpers of the model gateway admin page.
import type { GatewayModel, UsageRow } from "../types.ts";

/** One model per line: `id` or `id | display name`. Blank lines and duplicate ids are dropped. */
export function parseModels(text: string): GatewayModel[] {
	const seen = new Set<string>();
	const out: GatewayModel[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const bar = line.indexOf("|");
		const id = (bar === -1 ? line : line.slice(0, bar)).trim();
		const name = bar === -1 ? "" : line.slice(bar + 1).trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(name ? { id, name } : { id });
	}
	return out;
}

export function modelsToText(models: readonly GatewayModel[]): string {
	return models.map((m) => (m.name && m.name !== m.id ? `${m.id} | ${m.name}` : m.id)).join("\n");
}

/** Share of the largest total, in percent, for the plain-div bars of the usage page (at least 1 for a non-zero value). */
export function barPercent(value: number, max: number): number {
	if (max <= 0 || value <= 0) return 0;
	return Math.max(1, Math.round((value / max) * 100));
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	requests: number;
}

export function usageTotals(rows: readonly UsageRow[]): UsageTotals {
	return rows.reduce<UsageTotals>(
		(sum, r) => ({ inputTokens: sum.inputTokens + r.inputTokens, outputTokens: sum.outputTokens + r.outputTokens, requests: sum.requests + r.requests }),
		{ inputTokens: 0, outputTokens: 0, requests: 0 },
	);
}
