import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { useMemo } from "react";
import type { RuntimeInfo, RuntimeKind } from "@prometheus/protocol";
import { isAndroid } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { gatewaysFor, setDraftSource, switchRuntime, useStore } from "../lib/store.ts";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		title: "Agent 运行时",
		hintDraft: "决定由哪个 Agent 来干活。开始后仍可随时切换",
		hintSession: "切换会新开一个会话并带上当前记录，原会话保留",
		busy: "回复结束后才能切换",
		current: "当前",
		own: "自带登录",
		ownHint: "使用该 CLI 自己的账号或配置",
		builtin: "内置，使用「网关」里配置的模型",
		unavailable: "不可用",
		needServer: "Android 本机模式下需连接服务器",
		source: "模型来源",
	},
	en: {
		title: "Agent runtime",
		hintDraft: "Which agent does the work. You can switch any time after starting",
		hintSession: "Switching opens a new chat with the current transcript; this one is kept",
		busy: "Wait for the reply to finish",
		current: "Current",
		own: "Own login",
		ownHint: "Uses the CLI's own account or config",
		builtin: "Built in; uses the models set up under Gateways",
		unavailable: "Unavailable",
		needServer: "Needs a server in Android local mode",
		source: "Model source",
	},
});

export const RUNTIME_LABEL: Record<RuntimeKind, string> = { pi: "PI", "claude-code": "Claude Code", codex: "Codex" };

const TINT: Record<RuntimeKind, string> = {
	pi: "bg-ember-500/15 text-ember-300",
	"claude-code": "bg-amber-500/15 text-amber-300",
	codex: "bg-sky-500/15 text-sky-300",
};

function Mark({ kind, dim }: { kind: RuntimeKind; dim?: boolean }) {
	return (
		<span className={clsx("flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-semibold", dim ? "bg-ink-800 text-ink-500" : TINT[kind])}>
			{kind === "pi" ? "π" : kind === "codex" ? "Cx" : "CC"}
		</span>
	);
}

interface Source {
	id: string | null;
	name: string;
	hint?: string;
}

/**
 * One chooser for both moments: on the new-chat page it sets the draft, in an open chat it continues the
 * conversation in another runtime. Each runtime is a card; its model sources are the options beneath it.
 */
export function RuntimeMenu({ mode }: { mode: "draft" | "session" }) {
	const t = useT(M);
	const runtimes = useStore((s) => s.runtimes);
	const allGateways = useStore((s) => s.gateways);
	const draftRuntime = useStore((s) => s.draftRuntime);
	const draftGatewayId = useStore((s) => s.draftGatewayId);
	const session = useStore((s) => s.session);
	const { open, setOpen, ref } = usePopover();

	const selected = useMemo(() => {
		if (mode === "draft") return { kind: draftRuntime, gatewayId: draftGatewayId };
		const g = session?.gateway;
		return { kind: session?.runtime ?? "pi", gatewayId: g?.mode === "prometheus" ? g.gatewayId : null };
	}, [mode, draftRuntime, draftGatewayId, session?.runtime, session?.gateway]);
	const busy = mode === "session" && (session?.isStreaming ?? false);

	const groups = useMemo(
		() =>
			runtimes.map((info: RuntimeInfo) => ({
				info,
				sources: (info.kind === "pi" ? [] : [{ id: null, name: t("own"), hint: t("ownHint") }, ...gatewaysFor(info.kind, allGateways).map((g) => ({ id: g.id, name: g.name }))]) as Source[],
			})),
		[runtimes, allGateways, t],
	);
	if (runtimes.length === 0) return null;

	const sourceName = selected.gatewayId ? (allGateways.find((g) => g.id === selected.gatewayId)?.name ?? selected.gatewayId) : null;
	const choose = (kind: RuntimeKind, gatewayId: string | null) => {
		if (busy || (kind === selected.kind && gatewayId === selected.gatewayId)) return;
		setOpen(false);
		if (mode === "draft") setDraftSource(kind, gatewayId);
		else void switchRuntime(kind, gatewayId);
	};

	return (
		<div ref={ref} className="md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex max-w-56 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
				title={`${t("title")} · ${mode === "draft" ? t("hintDraft") : t("hintSession")}`}
			>
				<span className={clsx("flex size-4 shrink-0 items-center justify-center rounded font-mono text-[9px] font-semibold", TINT[selected.kind])}>{selected.kind === "pi" ? "π" : selected.kind === "codex" ? "Cx" : "CC"}</span>
				<span className="min-w-0 truncate">
					{RUNTIME_LABEL[selected.kind]}
					{sourceName && <span className="text-ink-500"> · {sourceName}</span>}
				</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 max-h-[70vh] overflow-y-auto md:left-0 md:right-auto md:w-[22rem] animate-rise rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="px-3.5 pt-3 pb-2">
						<div className="text-sm font-medium text-ink-100">{t("title")}</div>
						<div className="mt-0.5 text-xs text-ink-500">{busy ? t("busy") : mode === "draft" ? t("hintDraft") : t("hintSession")}</div>
					</div>
					<div className="space-y-1.5 px-2 pb-2">
						{groups.map(({ info, sources }) => {
							const ok = info.health.available;
							const isCurrentRuntime = info.kind === selected.kind;
							const reason = ok ? "" : [info.kind !== "pi" && isAndroid() ? t("needServer") : null, info.health.reason ?? t("unavailable")].filter(Boolean).join(" · ");
							const head = (
								<div className="flex items-center gap-2.5">
									<Mark kind={info.kind} dim={!ok} />
									<div className="min-w-0 flex-1">
										<div className="flex items-baseline gap-1.5">
											<span className={clsx("text-sm font-medium", ok ? "text-ink-100" : "text-ink-500")}>{RUNTIME_LABEL[info.kind]}</span>
											{info.health.version && <span className="font-mono text-[10.5px] text-ink-500">{info.health.version}</span>}
										</div>
										{reason ? <div className="truncate text-[11px] text-ink-500" title={reason}>{reason}</div> : info.kind === "pi" ? <div className="text-[11px] text-ink-500">{t("builtin")}</div> : null}
									</div>
									{info.kind === "pi" && isCurrentRuntime && (mode === "session" ? <span className="text-[11px] text-ember-300">{t("current")}</span> : <Check className="size-4 shrink-0 text-ember-300" />)}
								</div>
							);
							return (
								<div key={info.kind} className={clsx("rounded-lg border transition-colors", isCurrentRuntime ? "border-ember-500/40 bg-ember-500/5" : "border-ink-800")}>
									{info.kind === "pi" ? (
										<button type="button" disabled={!ok || busy || isCurrentRuntime} onClick={() => choose("pi", null)} className="w-full rounded-lg p-2.5 text-left disabled:cursor-default enabled:hover:bg-ink-800">
											{head}
										</button>
									) : (
										<>
											<div className="p-2.5 pb-1.5">{head}</div>
											{ok && (
												<div className="flex flex-wrap gap-1.5 px-2.5 pb-2.5 pl-[3.1rem]" role="radiogroup" aria-label={t("source")}>
													{sources.map((s) => {
														const on = isCurrentRuntime && s.id === selected.gatewayId;
														return (
															<button
																key={s.id ?? "own"}
																type="button"
																role="radio"
																aria-checked={on}
																disabled={busy}
																title={s.hint}
																onClick={() => choose(info.kind, s.id)}
																className={clsx(
																	"flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
																	on ? "border-ember-500/60 bg-ember-500/15 text-ember-200" : "border-ink-700 text-ink-300 hover:border-ink-500 hover:text-ink-100",
																)}
															>
																{on && <Check className="size-3" />}
																{s.name}
															</button>
														);
													})}
												</div>
											)}
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
