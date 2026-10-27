import clsx from "clsx";
import { Check, ChevronDown, Layers, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import type { ModeInEffect, ModeSummary } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginActive, pluginCall, toast, useStore } from "../lib/store.ts";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		title: "Agent 模式",
		hint: "切换后从下一句话开始生效，不重载会话",
		host: "宿主默认",
		hostDesc: "pi 自带的提示词与全部工具",
		workspace: "工作区默认",
		session: "仅本会话",
		inherit: "跟随工作区默认",
		off: "默认关闭",
		offHint: "新会话默认用宿主提示词；想默认套用某个模式就打开它",
		on: "默认开启",
		applied: "上一轮实际生效",
		notYet: "还没跑过一轮",
		none: "没有安装模式插件",
	},
	en: {
		title: "Agent mode",
		hint: "Applies from the next message; nothing reloads",
		host: "Host default",
		hostDesc: "pi's own prompt and every tool",
		workspace: "Workspace default",
		session: "This chat only",
		inherit: "Follow the workspace default",
		off: "Off by default",
		offHint: "A new chat runs on the host prompt; switch this on to start in a mode",
		on: "On by default",
		applied: "Took effect last turn",
		notYet: "No turn has run yet",
		none: "Modes plugin is not installed",
	},
});

/**
 * Composer-footer switcher for the agent mode.
 *
 * Two different things live here: which mode *this chat* runs (an override, applied on its own) and
 * what a *new* chat starts in (the workspace default plus its on/off switch). Changing either is
 * just a state write — the plugin reads it when the next run starts — so switching costs nothing
 * and never reloads a session.
 */
export function ModePicker() {
	const t = useT(M);
	const plugins = useStore((s) => s.plugins);
	const sessionId = useStore((s) => s.session?.id);
	const { open, setOpen, ref } = usePopover();
	const [modes, setModes] = useState<ModeSummary[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [defaultEnabled, setDefaultEnabled] = useState(false);
	const [effect, setEffect] = useState<ModeInEffect | null>(null);
	const active = pluginActive(plugins, "modes");

	const refresh = async () => {
		if (!active) return;
		const res = await pluginCall<{ selected: string | null; defaultEnabled: boolean; modes: ModeSummary[] }>("modes", "list");
		if (res) {
			setModes(res.modes.filter((m) => m.enabled));
			setSelected(res.selected);
			setDefaultEnabled(res.defaultEnabled);
		}
		const eff = await pluginCall<ModeInEffect>("modes", "effective", { session: sessionId ?? "" });
		if (eff) setEffect(eff);
	};

	useEffect(() => {
		void refresh();
		// The open state matters too: a reopened popover must not show a stale list.
	}, [active, sessionId, open]);

	if (!active) return null;

	const pick = async (id: string | null) => {
		setOpen(false);
		const res = await pluginCall<{ id: string | null }>("modes", "override", { session: sessionId ?? "", id });
		if (res === undefined) return;
		toast(id ? t("session") : t("inherit"));
		await refresh();
	};

	const makeDefault = async (id: string | null) => {
		setOpen(false);
		const res = await pluginCall<{ selected: string | null }>("modes", "select", { id });
		if (res === undefined) return;
		await refresh();
	};

	const toggleDefault = async () => {
		const res = await pluginCall<{ enabled: boolean }>("modes", "default", { enabled: !defaultEnabled });
		if (res === undefined) return;
		setDefaultEnabled(res.enabled);
		await refresh();
	};

	const currentTitle = effect?.title ?? t("host");
	const own = effect?.source === "session";

	return (
		<div ref={ref} className="shrink-0 md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className={clsx(
					"flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors hover:bg-ink-800",
					effect?.id ? "text-ember-300" : "text-ink-400 hover:text-ink-200",
				)}
				title={t("title")}
			>
				<Layers className="size-3.5 shrink-0" />
				<span className="max-w-20 truncate whitespace-nowrap sm:max-w-40">{currentTitle}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 max-h-[70vh] overflow-y-auto md:left-0 md:right-auto md:w-96 animate-rise rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="flex items-baseline justify-between px-3.5 pt-3 pb-1">
						<span className="text-sm font-medium text-ink-100">{t("title")}</span>
						<span className="font-mono text-[10.5px] text-ink-500">{t("hint")}</span>
					</div>

					<div className="px-2 pb-1">
						<Row on={!effect?.id} icon={<Radio className="size-4 shrink-0 text-ink-400" />} title={t("host")} desc={t("hostDesc")} onClick={() => void pick(null)} />
						{modes.map((m) => (
							<Row
								key={m.id}
								on={effect?.id === m.id}
								icon={<Layers className={clsx("size-4 shrink-0", effect?.id === m.id ? "text-ember-300" : "text-ink-500")} />}
								title={m.title}
								desc={m.description || `${m.compose} · ${m.bodyLength}`}
								tag={own && effect?.id === m.id ? t("session") : selected === m.id ? t("workspace") : undefined}
								onClick={() => void pick(m.id)}
							/>
						))}
					</div>

					<div className="border-t hairline px-3.5 py-2.5">
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs text-ink-300">{defaultEnabled ? t("on") : t("off")}</span>
							<button
								type="button"
								onClick={() => void toggleDefault()}
								className={clsx("rounded-md px-2 py-1 text-xs transition-colors", defaultEnabled ? "bg-ember-500/15 text-ember-200" : "bg-ink-800 text-ink-400 hover:text-ink-200")}
							>
								{defaultEnabled ? t("on") : t("off")}
							</button>
						</div>
						<p className="mt-1 text-[11px] text-ink-500">{t("offHint")}</p>
						<div className="mt-2 flex items-center justify-between gap-2">
							<span className="text-xs text-ink-400">{t("workspace")}</span>
							<select
								value={selected ?? ""}
								onChange={(e) => void makeDefault(e.target.value || null)}
								className="max-w-48 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-ink-200"
							>
								<option value="">{t("host")}</option>
								{modes.map((m) => (
									<option key={m.id} value={m.id}>
										{m.title}
									</option>
								))}
							</select>
						</div>
					</div>

					<div className="border-t hairline px-3.5 py-2 text-[11px] text-ink-500">
						{effect?.applied?.at
							? `${t("applied")}: ${[effect.applied.identity ? "identity" : "", effect.applied.docs ? "docs" : ""].filter(Boolean).join(" + ") || "—"}`
							: t("notYet")}
					</div>
				</div>
			)}
		</div>
	);
}

function Row({ on, icon, title, desc, tag, onClick }: { on: boolean; icon: React.ReactNode; title: string; desc: string; tag?: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className={clsx("flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left", on ? "bg-ember-500/10" : "hover:bg-ink-800")}>
			<span className="mt-0.5">{icon}</span>
			<span className="min-w-0 flex-1">
				<span className={clsx("flex items-center gap-1.5 text-sm", on ? "text-ember-200" : "text-ink-100")}>
					<span className="truncate">{title}</span>
					{tag && <span className="shrink-0 rounded bg-ink-800 px-1 py-px text-[10px] text-ink-400">{tag}</span>}
				</span>
				<span className="mt-0.5 line-clamp-2 block text-xs text-ink-500">{desc}</span>
			</span>
			{on && <Check className="mt-0.5 size-3.5 shrink-0 text-ember-300" />}
		</button>
	);
}
