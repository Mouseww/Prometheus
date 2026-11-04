// Auto-compaction threshold, expressed to the user as a percentage of the context window.
//
// PI decides by absolute numbers: `shouldCompact` fires when `contextTokens > contextWindow - reserveTokens`, so the
// threshold is really "how much headroom to leave free". Users think in percent ("compact at 80% full"), and the
// window differs per model, so the percentage is converted here: reserve = window * (1 - percent/100).
//
import { DEFAULT_COMPACT_PERCENT, MAX_COMPACT_PERCENT, MIN_COMPACT_PERCENT } from "@prometheus/protocol";

// The value is applied per SettingsManager instance because every session creates its own (see `attach`), and kept in
// memory only: `applyOverrides` does not write settings.json, so a hand-edited PI config is left alone.

// The bounds live in the protocol so the settings slider and the server validate against the same range.
export { DEFAULT_COMPACT_PERCENT, MAX_COMPACT_PERCENT, MIN_COMPACT_PERCENT };

/** SettingsManager surface this module needs; structural so the PI type is not imported here. */
export interface CompactionAware {
	getCompactionSettings(model?: { provider: string; id: string }): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	applyOverrides(overrides: { compaction: { reserveTokens: number } }): void;
}

/** Percent → the `reserveTokens` PI compares against. Clamped so a bad config cannot disable compaction by accident. */
export function reserveForPercent(percent: number, contextWindow: number): number {
	// Math.min/max propagate NaN, which would silently produce an unusable reserve; fall back to the default first.
	const safe = Number.isFinite(percent) ? percent : DEFAULT_COMPACT_PERCENT;
	const clamped = Math.min(MAX_COMPACT_PERCENT, Math.max(MIN_COMPACT_PERCENT, safe));
	return Math.max(0, Math.round(contextWindow * (1 - clamped / 100)));
}

/**
 * Point a session's compaction at the configured percentage. A model without a usable window (0: unknown) is left as
 * is: guessing a window would compact at the wrong time, which is worse than the default.
 */
export function applyCompactPercent(settings: CompactionAware, percent: number, contextWindow: number): void {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
	settings.applyOverrides({ compaction: { reserveTokens: reserveForPercent(percent, contextWindow) } });
}
