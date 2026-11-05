import type { HubDeps } from "./deps.ts";
import { LOG_PREFIX } from "./log.ts";
import type { ReportsService } from "./services/reports.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 60_000;
const DEFAULT_TZ = "UTC";

export interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
		formatters.set(tz, f);
	}
	return f;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
	try {
		formatterFor(tz);
		return true;
	} catch {
		return false;
	}
}

/** Wall-clock parts of an instant in a time zone. Throws RangeError for an unknown zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
	const out: Record<string, number> = {};
	for (const p of formatterFor(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
	return { year: out.year as number, month: out.month as number, day: out.day as number, hour: out.hour as number, minute: out.minute as number };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDate(ms: number, tz: string): string {
	const p = zonedParts(ms, tz);
	return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` string. */
export function addDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Offset of the zone from UTC at an instant, in ms (positive east of Greenwich). Minute resolution is enough for every real zone. */
function offsetAt(ms: number, tz: string): number {
	const p = zonedParts(ms, tz);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
}

/** `[start, end)` of a local calendar day as UTC instants. Handles DST days of 23 or 25 hours. */
export function zonedDayRange(date: string, tz: string): { start: Date; end: Date } {
	const startOf = (day: string): number => {
		const [y, m, d] = day.split("-").map(Number) as [number, number, number];
		const guess = Date.UTC(y, m - 1, d);
		const first = guess - offsetAt(guess, tz);
		return guess - offsetAt(first, tz);
	};
	return { start: new Date(startOf(date)), end: new Date(startOf(addDays(date, 1))) };
}

/** `HH:MM` to minutes after midnight, or undefined when malformed. */
export function parseClock(value: string): number | undefined {
	const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!m) return undefined;
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h < 24 && min < 60 ? h * 60 + min : undefined;
}

/**
 * A workspace's report for the previous local day is due once the local clock has reached the configured time.
 * It stays due until the report exists, so a Hub that was down at the configured minute catches up on the next tick.
 */
export function reportDue(nowMs: number, tz: string, time: string): { due: boolean; date: string } {
	const configured = parseClock(time);
	const zone = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
	const p = zonedParts(nowMs, zone);
	const today = localDate(nowMs, zone);
	return { due: configured !== undefined && p.hour * 60 + p.minute >= configured, date: addDays(today, -1) };
}

export interface ReportScheduler {
	/** One pass over all workspaces; returns `<workspaceId>:<date>` for each report generated. */
	tick(): Promise<string[]>;
	stop(): void;
}

interface DueRow {
	id: string;
	daily_report_time: string;
	daily_report_tz: string;
	created_at: Date | string;
}

/** Every minute: generate the previous day's report for each workspace whose configured time has passed. Registered with `deps.onClose`. */
export function createReportScheduler(deps: HubDeps, reports: ReportsService, options: { intervalMs?: number; start?: boolean } = {}): ReportScheduler {
	let running = false;

	const tick = async (): Promise<string[]> => {
		if (running) return [];
		running = true;
		const generated: string[] = [];
		try {
			const rows = await deps.db.query<DueRow>("SELECT id, daily_report_time, daily_report_tz, created_at FROM workspaces WHERE daily_report_enabled");
			const nowMs = deps.now();
			for (const ws of rows) {
				const { due, date } = reportDue(nowMs, ws.daily_report_tz, ws.daily_report_time);
				if (!due) continue;
				try {
					// A workspace created after the report day has nothing to report.
					const zone = isValidTimeZone(ws.daily_report_tz) ? ws.daily_report_tz : DEFAULT_TZ;
					if (new Date(ws.created_at).getTime() >= zonedDayRange(date, zone).end.getTime()) continue;
					if (await reports.exists(ws.id, date)) continue;
					await reports.generateFor(ws.id, date);
					generated.push(`${ws.id}:${date}`);
				} catch (err) {
					deps.log.warn(`${LOG_PREFIX} 生成日报失败 (工作区 ${ws.id}, ${date}): ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} catch (err) {
			deps.log.warn(`${LOG_PREFIX} 日报调度检查失败: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			running = false;
		}
		return generated;
	};

	let timer: NodeJS.Timeout | undefined;
	if (options.start !== false) {
		timer = setInterval(() => void tick(), options.intervalMs ?? TICK_INTERVAL_MS);
		timer.unref();
	}
	return {
		tick,
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
		},
	};
}
