import type { AutomationSchedule } from "@prometheus/protocol";

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 7 * 24 * 60;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Reasons a schedule is unusable; empty when fine. */
export function validateSchedule(s: AutomationSchedule): string[] {
	if (s.type === "interval") {
		if (!Number.isInteger(s.minutes) || s.minutes < MIN_INTERVAL || s.minutes > MAX_INTERVAL) return [`间隔需为 ${MIN_INTERVAL} 到 ${MAX_INTERVAL} 分钟的整数`];
		return [];
	}
	if (s.type === "daily") {
		const errors: string[] = [];
		if (!TIME.test(s.time)) errors.push("时间格式应为 HH:MM");
		if (s.days && (!s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) errors.push("星期需为 0（周日）到 6 的数字");
		return errors;
	}
	if (s.type === "once") return Number.isNaN(Date.parse(s.at)) ? ["执行时间不合法"] : [];
	return ["未知的调度类型"];
}

/**
 * The first moment strictly after `after` at which the schedule fires, or undefined when it never will
 * again. Daily schedules use the machine's local time, and walk day by day so daylight-saving shifts
 * land on the right wall-clock time.
 */
export function nextRun(s: AutomationSchedule, after: Date): Date | undefined {
	if (s.type === "interval") return new Date(after.getTime() + s.minutes * 60_000);
	if (s.type === "once") {
		const at = new Date(s.at);
		return at.getTime() > after.getTime() ? at : undefined;
	}
	const m = TIME.exec(s.time);
	if (!m) return undefined;
	const [h, min] = [Number(m[1]), Number(m[2])];
	const days = s.days?.length ? new Set(s.days) : undefined;
	for (let i = 0; i <= 8; i++) {
		const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, h, min, 0, 0);
		if (d.getTime() > after.getTime() && (!days || days.has(d.getDay()))) return d;
	}
	return undefined;
}

/**
 * When a task that missed its slot (app closed, machine asleep) should catch up. Interval tasks just
 * skip ahead; a daily or one-off task that was due while the app was off runs once on the next start,
 * unless it is more than a day late, in which case running it would surprise the user.
 */
export function catchUpDue(s: AutomationSchedule, due: Date, now: Date): boolean {
	if (s.type === "interval") return false;
	return now.getTime() - due.getTime() <= 24 * 3_600_000;
}

export function describeSchedule(s: AutomationSchedule): string {
	if (s.type === "interval") return s.minutes % 60 === 0 ? `每 ${s.minutes / 60} 小时` : `每 ${s.minutes} 分钟`;
	if (s.type === "once") return `一次 ${new Date(s.at).toLocaleString()}`;
	const names = ["日", "一", "二", "三", "四", "五", "六"];
	const days = s.days?.length && s.days.length < 7 ? `每周${[...s.days].sort().map((d) => names[d]).join("、")}` : "每天";
	return `${days} ${s.time}`;
}
