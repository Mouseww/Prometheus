import { createJsonStore, type JsonStore } from "@prometheus/plugin-sdk";
import type { HostSettings, SyncReport, SyncSettings } from "@prometheus/protocol";

/** The part of the host settings that means the same thing on any machine. */
export function pickSyncSettings(s: HostSettings): SyncSettings {
	return {
		autoCompaction: s.autoCompaction,
		defaultAgent: s.defaultAgent,
		defaultPermission: s.defaultPermission,
		defaultThinking: s.defaultThinking,
		goalTurns: s.goalTurns,
		compactPercent: s.compactPercent,
		worktreeMode: s.worktreeMode,
		worktreeDefault: s.worktreeDefault,
		worktreeStrategy: s.worktreeStrategy,
		worktreeAutoPull: s.worktreeAutoPull,
		recycleDays: s.recycleDays,
	};
}

/** Keeps only known, well-typed fields of an incoming settings object; a hand-made bundle cannot smuggle in anything else. */
export function cleanSyncSettings(raw: unknown): Partial<SyncSettings> {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of ["autoCompaction", "worktreeDefault", "worktreeAutoPull"]) if (typeof r[k] === "boolean") out[k] = r[k];
	for (const k of ["defaultAgent", "defaultPermission", "defaultThinking", "worktreeMode", "worktreeStrategy"]) if (typeof r[k] === "string") out[k] = r[k];
	for (const k of ["goalTurns", "compactPercent", "recycleDays"]) if (typeof r[k] === "number" && Number.isFinite(r[k])) out[k] = r[k];
	return out as Partial<SyncSettings>;
}

export const emptyReport = (): SyncReport => ({
	gateways: { added: 0, updated: 0, skipped: [] },
	settings: false,
	projects: { added: 0, skipped: [] },
	sessions: { added: 0, skipped: [] },
});

/** Remembers which local chat each imported chat became, so syncing twice never duplicates it. */
export class SyncLedger {
	private readonly store: JsonStore<Record<string, string>>;

	constructor(file: string) {
		this.store = createJsonStore<Record<string, string>>(file, () => ({}));
	}

	async get(originId: string): Promise<string | undefined> {
		return (await this.store.read())[originId];
	}

	async set(originId: string, localId: string): Promise<void> {
		await this.store.update((m) => ({ ...m, [originId]: localId }));
	}
}
