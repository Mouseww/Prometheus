import clsx from "clsx";
import { type AgentProfile, agentPreset, type RuntimeInfo } from "@prometheus/protocol";
import { Check, Download, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { initRuntimes, installRuntime, useRuntimes } from "../lib/runtimes.ts";
import { call, refreshRuntimes, resetDraftAgent, toast, useStore } from "../lib/store.ts";
import { JobView } from "./RuntimesSettings.tsx";
import { Button, Flame } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "选一个智能体开始",
		intro: "Prometheus 不再强制自带 PI Agent，它和 Claude Code、Codex 等一样，是可选的智能体引擎。现在一个都还不能用，请至少安装一个（默认选中 PI），之后随时可以在 设置 → Agent 里增减。",
		pi: "PI Agent",
		piDesc: "Prometheus 默认的智能体引擎，支持全部功能（约 70 MB，通过 npm 安装）",
		install: "安装并开始",
		installing: "正在安装…",
		retry: "重试",
		notHere: "当前连接的是远程服务端，无法在这里安装 PI Agent；请在服务端所在机器安装，或选择其他智能体。",
		noNpm: "找不到 npm，无法一键安装；请先安装 Node.js 或手动安装它的命令行工具。",
		manual: "没有一键安装方式，请按它自己的说明安装。",
		skip: "稍后再说",
		restarting: "安装完成，正在重新启动后端…",
	},
	en: {
		title: "Pick an agent to get started",
		intro: "Prometheus no longer forces the PI Agent on you: it is an optional agent engine like Claude Code or Codex. None of them is usable yet, so install at least one (PI is preselected). You can add or remove agents any time under Settings -> Agents.",
		pi: "PI Agent",
		piDesc: "Prometheus' default agent engine with every feature (about 70 MB, installed with npm)",
		install: "Install and start",
		installing: "Installing…",
		retry: "Retry",
		notHere: "This is a remote server, so the PI Agent cannot be installed from here. Install it on the server's machine, or pick another agent.",
		noNpm: "npm was not found, so there is no one-click install. Install Node.js first, or install its command line tool yourself.",
		manual: "There is no one-click install; follow the agent's own instructions.",
		skip: "Later",
		restarting: "Installed, restarting the backend…",
	},
});

/**
 * Shown when no agent runtime works. The PI Agent is one choice among the supported ones (preselected), not a requirement:
 * any agent that becomes usable ends this screen.
 */
export function AgentSetup({ local, onRestartBackend, onSkip }: { local: boolean; onRestartBackend: () => Promise<void>; onSkip: () => void }) {
	const t = useT(M);
	const runtimes = useStore((s) => s.runtimes);
	const [agents, setAgents] = useState<AgentProfile[]>([]);
	const [selected, setSelected] = useState("pi");
	const [busy, setBusy] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const job = useRuntimes((s) => s.jobs["pi-agent"]);

	useEffect(() => {
		void initRuntimes();
		void call((c) => c.rpc("agent.list", {})).then((list) => list && setAgents(list));
	}, []);

	// Everything this server lists as an agent, PI first and preselected.
	const rows: { id: string; name: string; desc: string; info: RuntimeInfo | undefined; pkg: string | undefined }[] = runtimes
		.filter((r) => r.id === "pi" || agents.some((a) => a.id === r.id && a.enabled !== false))
		.map((r) => ({
			id: r.id,
			name: r.id === "pi" ? t("pi") : r.name,
			desc: r.id === "pi" ? t("piDesc") : (agentPreset(r.id)?.npm?.pkg ?? ""),
			info: r,
			pkg: agentPreset(r.id)?.npm?.pkg,
		}));
	const row = rows.find((r) => r.id === selected) ?? rows[0];
	const isPi = row?.id === "pi";
	const piJobRunning = !!job && !job.finished;
	const failed = !!job && job.finished && !job.ok;

	useEffect(() => {
		if (!job?.finished || !job.ok || restarting) return;
		// The server loads the PI packages when it starts, so it has to be started again to see them.
		setRestarting(true);
		void onRestartBackend().catch((err: unknown) => {
			setRestarting(false);
			toast(err instanceof Error ? err.message : String(err), "error");
		});
	}, [job?.finished, job?.ok, restarting, onRestartBackend]);

	const hint = !row
		? null
		: isPi
			? local
				? null
				: t("notHere")
			: !row.pkg
				? t("manual")
				: row.info?.health.installable === false
					? t("noNpm")
					: null;
	const canInstall = !!row && !hint;

	const install = async () => {
		if (!row) return;
		if (isPi) return void (await installRuntime("pi-agent"));
		setBusy(true);
		try {
			const agent = agents.find((a) => a.id === row.id);
			await call((c) => c.rpc("agent.install", { kind: agent?.kind ?? (row.info?.kind as never), agent: row.id }));
			await refreshRuntimes();
			resetDraftAgent();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex h-full items-center justify-center overflow-y-auto px-4 py-8">
			<div className="w-full max-w-lg space-y-5 rounded-2xl border border-ink-800 bg-ink-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur">
				<div className="flex items-center gap-3">
					<Flame className="size-9" />
					<h1 className="font-display text-xl font-semibold text-ink-100">{t("title")}</h1>
				</div>
				<p className="text-sm leading-relaxed text-ink-400">{t("intro")}</p>
				<ul className="space-y-2" role="radiogroup">
					{rows.map((r) => {
						const on = r.id === row?.id;
						return (
							<li key={r.id}>
								<button
									type="button"
									role="radio"
									aria-checked={on}
									disabled={busy || piJobRunning || restarting}
									onClick={() => setSelected(r.id)}
									className={clsx("flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left", on ? "border-ember-500/50 bg-ember-500/10" : "border-ink-800 bg-ink-950/50 hover:bg-ink-800/60")}
								>
									<span className={clsx("flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-ember-400 text-ember-300" : "border-ink-600")}>{on && <Check className="size-3" />}</span>
									<span className="min-w-0 flex-1">
										<span className="block text-sm text-ink-100">{r.name}</span>
										{r.desc && <span className="block truncate font-mono text-xs text-ink-500">{r.desc}</span>}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
				{isPi && job && !restarting && <JobView job={job} />}
				{hint && <p className="text-xs leading-relaxed text-ink-400">{hint}</p>}
				{restarting ? (
					<div className="flex items-center gap-2 text-sm text-ink-300">
						<LoaderCircle className="size-4 animate-spin" /> {t("restarting")}
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="primary" disabled={!canInstall || busy || piJobRunning} onClick={() => void install()}>
							{busy || piJobRunning ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />} {busy || piJobRunning ? t("installing") : failed && isPi ? t("retry") : t("install")}
						</Button>
						<Button variant="ghost" onClick={onSkip} disabled={busy || piJobRunning}>
							{t("skip")}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
