import clsx from "clsx";
import { useMemo } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import type { RuntimeKind } from "@prometheus/protocol";
import { isAndroid } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { gatewaysFor, switchRuntime, useStore } from "../lib/store.ts";
import { RUNTIME_LABEL } from "./RuntimePicker.tsx";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		title: "切换 Agent 运行时",
		hint: "在新会话里接着聊，当前会话保留；对话记录会作为背景交给新的运行时",
		busy: "回复结束后才能切换",
		native: "自带登录",
		unavailable: "不可用",
		needServer: "Android 本机模式下不可用，需连接服务器",
		current: "当前",
	},
	en: {
		title: "Switch agent runtime",
		hint: "Continues in a new chat; this one is kept. The transcript is handed to the new runtime as background",
		busy: "Wait for the reply to finish",
		native: "Own login",
		unavailable: "Unavailable",
		needServer: "Needs a server in Android local mode",
		current: "Current",
	},
});

/** Composer-footer control of an open chat: continue the conversation in another runtime. */
export function RuntimeSwitcher() {
	const t = useT(M);
	const current = useStore((s) => s.session?.runtime ?? "pi");
	const busy = useStore((s) => s.session?.isStreaming ?? false);
	const runtimes = useStore((s) => s.runtimes);
	const allGateways = useStore((s) => s.gateways);
	const { open, setOpen, ref } = usePopover();
	const rows = useMemo(
		() =>
			runtimes.map((r) => ({
				info: r,
				gateways: r.kind === "pi" ? [] : gatewaysFor(r.kind, allGateways),
			})),
		[runtimes, allGateways],
	);
	if (runtimes.length === 0) return null;

	const pick = (kind: RuntimeKind, gatewayId: string | null) => {
		setOpen(false);
		void switchRuntime(kind, gatewayId);
	};
	const item = "flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50";

	return (
		<div ref={ref} className="md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200"
				title={busy ? t("busy") : `${t("title")} · ${t("hint")}`}
			>
				<Cpu className="size-3.5 shrink-0" />
				<span>{RUNTIME_LABEL[current]}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 md:left-0 md:right-auto md:w-80 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="px-3.5 pt-3 pb-1 text-sm font-medium text-ink-100">{t("title")}</div>
					<div className="px-3.5 pb-2 text-xs text-ink-500">{busy ? t("busy") : t("hint")}</div>
					<div className="pb-1.5">
						{rows.map(({ info, gateways }) => {
							const off = !info.health.available || busy;
							const reason = !info.health.available ? [info.kind !== "pi" && isAndroid() ? t("needServer") : null, info.health.reason ?? t("unavailable")].filter(Boolean).join(" · ") : "";
							return (
								<div key={info.kind} className="border-t border-ink-800 first:border-t-0">
									<div className="flex items-baseline gap-2 px-3.5 pt-2 pb-0.5 text-xs text-ink-400">
										<span className="font-medium text-ink-300">{RUNTIME_LABEL[info.kind]}</span>
										{info.kind === current && <span className="text-ember-300">{t("current")}</span>}
										{reason && <span className="truncate text-ink-500">{reason}</span>}
									</div>
									{info.kind === "pi" ? (
										<button type="button" disabled={off || current === "pi"} onClick={() => pick("pi", null)} className={clsx(item, "text-ink-100 hover:bg-ink-800")}>
											PI
										</button>
									) : (
										<>
											<button type="button" disabled={off} onClick={() => pick(info.kind, null)} className={clsx(item, "text-ink-100 hover:bg-ink-800")}>
												{t("native")}
											</button>
											{gateways.map((g) => (
												<button key={g.id} type="button" disabled={off} onClick={() => pick(info.kind, g.id)} className={clsx(item, "text-ink-100 hover:bg-ink-800")}>
													<span className="truncate">{g.name}</span>
												</button>
											))}
										</>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
