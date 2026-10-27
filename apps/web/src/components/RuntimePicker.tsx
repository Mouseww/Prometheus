import clsx from "clsx";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { RuntimeKind } from "@prometheus/protocol";
import { isAndroid } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { gatewaysFor, setDraftGateway, setDraftRuntime, useStore } from "../lib/store.ts";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		title: "Agent 运行时",
		hint: "创建会话后不可更换",
		unavailable: "不可用",
		needServer: "Android 本机模式下不可用，需连接服务器",
		gateway: "模型来源",
		native: "运行时自带登录",
	},
	en: {
		title: "Agent runtime",
		hint: "Fixed once the chat starts",
		unavailable: "Unavailable",
		needServer: "Needs a server in Android local mode",
		gateway: "Model source",
		native: "Runtime's own login",
	},
});

export const RUNTIME_LABEL: Record<RuntimeKind, string> = { pi: "PI", "claude-code": "Claude Code", codex: "Codex" };

/** New-chat chooser for which agent drives the session. Unavailable runtimes are greyed out with the reason. */
export function RuntimePicker() {
	const t = useT(M);
	const runtime = useStore((s) => s.draftRuntime);
	const runtimes = useStore((s) => s.runtimes);
	const gatewayId = useStore((s) => s.draftGatewayId);
	const gateways = useStore((s) => gatewaysFor(s.draftRuntime, s.gateways));
	const { open, setOpen, ref } = usePopover();
	if (runtimes.length === 0) return null;

	return (
		<div ref={ref} className="md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200"
				title={`${t("title")} · ${t("hint")}`}
			>
				<Cpu className="size-3.5 shrink-0" />
				<span>{RUNTIME_LABEL[runtime]}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 md:left-0 md:right-auto md:w-72 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="px-3.5 pt-3 pb-1.5 text-sm font-medium text-ink-100">{t("title")}</div>
					<div className="pb-1.5">
						{runtimes.map((r) => (
							<button
								key={r.kind}
								type="button"
								disabled={!r.health.available}
								onClick={() => {
									setOpen(false);
									setDraftRuntime(r.kind);
								}}
								className={clsx(
									"flex w-full items-start gap-2.5 px-3.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50",
									r.kind === runtime ? "bg-ember-500/10" : "hover:bg-ink-800",
								)}
							>
								<span className="min-w-0 flex-1">
									<span className={clsx("block text-sm", r.kind === runtime ? "text-ember-200" : "text-ink-100")}>
										{RUNTIME_LABEL[r.kind]}
										{r.health.version ? <span className="ml-1.5 font-mono text-[10.5px] text-ink-500">{r.health.version}</span> : null}
									</span>
									{!r.health.available && <span className="block text-xs text-ink-500">{[r.kind !== "pi" && isAndroid() ? t("needServer") : null, r.health.reason ?? t("unavailable")].filter(Boolean).join(" · ")}</span>}
								</span>
								{r.kind === runtime && <Check className="mt-0.5 size-3.5 shrink-0 text-ember-300" />}
							</button>
						))}
					</div>
					{runtime !== "pi" && (
						<div className="border-t border-ink-800 pb-1.5">
							<div className="px-3.5 pt-2 pb-1 text-xs text-ink-500">{t("gateway")}</div>
							{[{ id: null as string | null, name: t("native") }, ...gateways].map((g) => (
								<button
									key={g.id ?? "native"}
									type="button"
									onClick={() => {
										setOpen(false);
										setDraftGateway(g.id);
									}}
									className={clsx("flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left text-sm", g.id === gatewayId ? "bg-ember-500/10 text-ember-200" : "text-ink-100 hover:bg-ink-800")}
								>
									<span className="min-w-0 flex-1 truncate">{g.name}</span>
									{g.id === gatewayId && <Check className="size-3.5 shrink-0 text-ember-300" />}
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
