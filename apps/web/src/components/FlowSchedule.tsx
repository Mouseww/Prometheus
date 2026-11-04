import clsx from "clsx";
import { useState } from "react";
import type { AutomationSchedule } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { Button, Dialog, Field, Input, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "定时运行",
		enable: "按计划自动运行这条流程",
		kind: "频率",
		daily: "每天固定时间",
		interval: "固定间隔",
		once: "仅一次",
		every: "每隔",
		minutes: "分钟",
		time: "时间",
		at: "执行时间",
		dayNames: "日,一,二,三,四,五,六",
		input: "定时运行时的输入",
		inputHint: "作为 {{input}} 传给流程。可留空。",
		next: "下次运行：{when}",
		saveHint: "保存流程后生效；应用关闭期间错过的每日/单次任务会在下次启动时补跑（一天内）。",
		unattended: "无人值守：步骤只能使用各自设置的权限，超出的操作会被直接拒绝。",
		done: "完成",
		cancel: "取消",
		badMinutes: "间隔需在 5 到 10080 分钟之间",
	},
	en: {
		title: "Scheduled runs",
		enable: "Run this flow automatically on a schedule",
		kind: "Frequency",
		daily: "Every day at a time",
		interval: "Fixed interval",
		once: "Once",
		every: "Every",
		minutes: "minutes",
		time: "Time",
		at: "Run at",
		dayNames: "Sun,Mon,Tue,Wed,Thu,Fri,Sat",
		input: "Input for scheduled runs",
		inputHint: "Passed to the flow as {{input}}. May be empty.",
		next: "Next run: {when}",
		saveHint: "Takes effect once the flow is saved. A daily or one-off run missed while the app was closed is made up on the next start (within a day).",
		unattended: "Unattended: steps only get the permission set on each of them; anything beyond that is refused.",
		done: "Done",
		cancel: "Cancel",
		badMinutes: "The interval must be between 5 and 10080 minutes",
	},
});

export interface ScheduleValue {
	schedule?: AutomationSchedule;
	scheduleEnabled?: boolean;
	scheduleInput?: string;
}

const toLocalInput = (iso: string) => {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function describeSchedule(s: AutomationSchedule | undefined, lang: "zh" | "en"): string {
	if (!s) return "";
	if (s.type === "interval") return lang === "zh" ? (s.minutes % 60 === 0 ? `每 ${s.minutes / 60} 小时` : `每 ${s.minutes} 分钟`) : s.minutes % 60 === 0 ? `Every ${s.minutes / 60} h` : `Every ${s.minutes} min`;
	if (s.type === "once") return (lang === "zh" ? "一次 " : "Once ") + new Date(s.at).toLocaleString();
	const names = M[lang].dayNames.split(",");
	const days = s.days?.length && s.days.length < 7 ? [...s.days].sort().map((d) => names[d]).join(lang === "zh" ? "、" : ", ") : lang === "zh" ? "每天" : "Daily";
	return `${days} ${s.time}`;
}

export function ScheduleDialog({ value, nextRunAt, lang, onClose, onApply }: { value: ScheduleValue; nextRunAt?: string; lang: "zh" | "en"; onClose: () => void; onApply: (v: ScheduleValue) => void }) {
	const t = useT(M);
	const [v, setV] = useState<ScheduleValue>({ ...value, schedule: value.schedule ?? { type: "daily", time: "09:00" } });
	const sch = v.schedule!;
	const set = (patch: Partial<ScheduleValue>) => setV((x) => ({ ...x, ...patch }));
	const setKind = (k: string) =>
		set({ schedule: k === "interval" ? { type: "interval", minutes: 60 } : k === "daily" ? { type: "daily", time: "09:00" } : { type: "once", at: new Date(Date.now() + 3_600_000).toISOString() } });
	const bad = sch.type === "interval" && (!Number.isInteger(sch.minutes) || sch.minutes < 5 || sch.minutes > 10080);
	const dayNames = t("dayNames").split(",");

	return (
		<Dialog title={t("title")} onClose={onClose}>
			<div className="max-h-[70dvh] space-y-4 overflow-y-auto pr-1">
				<label className="flex cursor-pointer items-center gap-2 text-sm text-ink-100">
					<input type="checkbox" checked={v.scheduleEnabled === true} onChange={(e) => set({ scheduleEnabled: e.target.checked })} className="size-4 accent-[#ff5a1f]" />
					{t("enable")}
				</label>
				<div className={clsx("space-y-3", !v.scheduleEnabled && "pointer-events-none opacity-50")}>
					<Field label={t("kind")}>
						<Select value={sch.type} onChange={(e) => setKind(e.target.value)}>
							<option value="daily">{t("daily")}</option>
							<option value="interval">{t("interval")}</option>
							<option value="once">{t("once")}</option>
						</Select>
					</Field>
					{sch.type === "interval" && (
						<div className="flex items-center gap-2 text-sm text-ink-400">
							{t("every")}
							<div className="w-28">
								<Input type="number" min={5} max={10080} value={sch.minutes} onChange={(e) => set({ schedule: { type: "interval", minutes: Number(e.target.value) } })} />
							</div>
							{t("minutes")}
						</div>
					)}
					{sch.type === "daily" && (
						<>
							<div className="w-36">
								<Input type="time" value={sch.time} onChange={(e) => set({ schedule: { ...sch, time: e.target.value || "09:00" } })} aria-label={t("time")} />
							</div>
							<div className="flex flex-wrap gap-1.5">
								{dayNames.map((name, d) => {
									const on = !sch.days?.length || sch.days.includes(d);
									return (
										<button
											key={d}
											type="button"
											onClick={() => {
												const current = sch.days?.length ? sch.days : [0, 1, 2, 3, 4, 5, 6];
												const next = current.includes(d) ? current.filter((x) => x !== d) : [...current, d];
												if (!next.length) return;
												set({ schedule: { type: "daily", time: sch.time, ...(next.length < 7 ? { days: next.sort() } : {}) } });
											}}
											className={clsx("min-w-8 rounded-lg border px-2 py-1 text-xs transition-colors", on ? "border-ember-500/60 bg-ember-500/10 text-ember-200" : "border-ink-700 text-ink-500 hover:border-ink-500")}
										>
											{name}
										</button>
									);
								})}
							</div>
						</>
					)}
					{sch.type === "once" && (
						<Input type="datetime-local" value={toLocalInput(sch.at)} onChange={(e) => e.target.value && set({ schedule: { type: "once", at: new Date(e.target.value).toISOString() } })} aria-label={t("at")} />
					)}
					<Field label={t("input")} hint={t("inputHint")}>
						<Textarea rows={3} value={v.scheduleInput ?? ""} onChange={(e) => set({ scheduleInput: e.target.value })} />
					</Field>
					{bad && <p className="text-xs text-rose-400">{t("badMinutes")}</p>}
				</div>
				{nextRunAt && value.scheduleEnabled && <p className="text-xs text-ember-300">{t("next", { when: new Date(nextRunAt).toLocaleString() })}</p>}
				<p className="text-[11px] leading-relaxed text-ink-500">
					{t("saveHint")} {t("unattended")}
				</p>
			</div>
			<div className="flex justify-end gap-2 pt-3">
				<Button variant="ghost" onClick={onClose}>
					{t("cancel")}
				</Button>
				<Button variant="primary" disabled={bad && v.scheduleEnabled === true} onClick={() => onApply(v)}>
					{t("done")}
				</Button>
			</div>
		</Dialog>
	);
}
