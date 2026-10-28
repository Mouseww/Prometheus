import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import type { RuntimeInfo, RuntimeKind } from "@prometheus/protocol";
import { isAndroid } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { openSettings, setDraftAgent, switchRuntime, useStore } from "../lib/store.ts";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: {
		title: "Agent",
		hintDraft: "选择由哪个 Agent 干活，模型在旁边的选择器里选。开始后仍可随时切换",
		hintSession: "切换后在当前会话里继续，已有记录会带过去",
		busy: "回复结束后才能切换",
		builtin: "内置，使用「网关」里配置的模型",
		unavailable: "不可用",
		needServer: "Android 本机模式下需连接服务器",
		manage: "管理 Agent…",
	},
	en: {
		title: "Agent",
		hintDraft: "Pick which agent does the work; choose the model in the picker next to it. You can switch any time after starting",
		hintSession: "Switching continues in this chat; the transcript so far carries over",
		busy: "Wait for the reply to finish",
		builtin: "Built in; uses the models set up under Gateways",
		unavailable: "Unavailable",
		needServer: "Needs a server in Android local mode",
		manage: "Manage agents…",
	},
});

const TINT: Record<RuntimeKind, string> = {
	pi: "bg-ember-500/15 text-ember-300",
	"claude-code": "bg-amber-500/15 text-amber-300",
	codex: "bg-sky-500/15 text-sky-300",
	opencode: "bg-emerald-500/15 text-emerald-300",
};
const GLYPH: Record<RuntimeKind, string> = { pi: "PI", "claude-code": "CC", codex: "Cx", opencode: "OC" };

function Mark({ kind, dim, small }: { kind: RuntimeKind; dim?: boolean; small?: boolean }) {
	return (
		<span
			className={clsx(
				"flex shrink-0 items-center justify-center font-mono font-semibold",
				small ? "size-4 rounded text-[9px]" : "size-7 rounded-lg text-[11px]",
				dim ? "bg-ink-800 text-ink-500" : TINT[kind],
			)}
		>
			{GLYPH[kind]}
		</span>
	);
}

/**
 * Chooser of the agent that drives a chat. On the new-chat page it sets the draft; in an open chat it continues
 * the conversation with another agent. Models are picked in the model picker, which lists what the agent can use.
 */
export function RuntimeMenu({ mode }: { mode: "draft" | "session" }) {
	const t = useT(M);
	const agents = useStore((s) => s.runtimes);
	const draftAgentId = useStore((s) => s.draftAgentId);
	const session = useStore((s) => s.session);
	const { open, setOpen, ref } = usePopover();

	const selectedId = mode === "draft" ? draftAgentId : (session?.agent ?? session?.runtime ?? "pi");
	const selected = agents.find((a) => a.id === selectedId) ?? agents.find((a) => a.kind === (session?.runtime ?? "pi"));
	const busy = mode === "session" && (session?.isStreaming ?? false);
	if (agents.length === 0) return null;

	const choose = (info: RuntimeInfo) => {
		if (busy || !info.health.available || info.id === selected?.id) return;
		setOpen(false);
		if (mode === "draft") void setDraftAgent(info);
		else void switchRuntime(info);
	};

	return (
		<div ref={ref} className="md:relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex max-w-28 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-300 sm:max-w-48 transition-colors hover:bg-ink-800 hover:text-ink-100"
				title={`${t("title")} · ${mode === "draft" ? t("hintDraft") : t("hintSession")}`}
			>
				<Mark kind={selected?.kind ?? "pi"} small />
				<span className="hidden min-w-0 truncate sm:inline">{selected?.name ?? "PI"}</span>
				<ChevronDown className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-3 right-3 z-40 mb-2 max-h-[70vh] overflow-y-auto md:left-0 md:right-auto md:w-80 animate-rise rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="px-3.5 pt-3 pb-2">
						<div className="text-sm font-medium text-ink-100">{t("title")}</div>
						<div className="mt-0.5 text-xs text-ink-500">{busy ? t("busy") : mode === "draft" ? t("hintDraft") : t("hintSession")}</div>
					</div>
					<div className="px-1.5 pb-1.5">
						{agents.map((a) => {
							const ok = a.health.available;
							const on = a.id === selected?.id;
							const reason = ok ? "" : [a.kind !== "pi" && isAndroid() ? t("needServer") : null, a.health.reason ?? t("unavailable")].filter(Boolean).join(" · ");
							return (
								<button
									key={a.id}
									type="button"
									disabled={!ok || busy}
									onClick={() => choose(a)}
									className={clsx(
										"flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-not-allowed",
										on ? "bg-ember-500/10" : "enabled:hover:bg-ink-800",
										(!ok || busy) && !on && "opacity-60",
									)}
								>
									<Mark kind={a.kind} dim={!ok} />
									<span className="min-w-0 flex-1">
										<span className="flex items-baseline gap-1.5">
											<span className={clsx("truncate text-sm font-medium", on ? "text-ember-200" : ok ? "text-ink-100" : "text-ink-500")}>{a.name}</span>
											{a.health.version && <span className="font-mono text-[10.5px] text-ink-500">{a.health.version}</span>}
										</span>
										{reason ? (
											<span className="block truncate text-[11px] text-ink-500" title={reason}>
												{reason}
											</span>
										) : a.kind === "pi" ? (
											<span className="block text-[11px] text-ink-500">{t("builtin")}</span>
										) : null}
									</span>
									{on && <Check className="size-4 shrink-0 text-ember-300" />}
								</button>
							);
						})}
					</div>
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							openSettings("agents");
						}}
						className="w-full border-t border-ink-800 px-3.5 py-2 text-left text-xs text-ink-400 hover:bg-ink-800 hover:text-ink-200"
					>
						{t("manage")}
					</button>
				</div>
			)}
		</div>
	);
}
