import { Check, Circle, Download, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { type SetupComponent } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { cancelRuntime, initRuntimes, installRuntime, useRuntimes } from "../lib/runtimes.ts";
import { JobView } from "./RuntimesSettings.tsx";
import { Button, Flame } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "先装好运行环境",
		intro: "为了让安装包保持小巧，Prometheus 不再自带 Node.js 和智能体引擎（PI Agent），首次使用时在这里一键安装。只需要做一次，之后会随应用一起更新。",
		node: "Node.js 22",
		nodeDesc: "后端的运行环境，含 npm（约 35 MB）",
		pi: "PI Agent",
		piDesc: "默认的智能体引擎及其模型库（约 70 MB，通过 npm 安装）",
		done: "已就绪",
		pending: "待安装",
		install: "一键安装",
		retry: "重试",
		cancel: "取消",
		starting: "安装完成，正在启动后端…",
		remote: "改用远程服务端",
		note: "需要联网。安装位置在应用自己的数据目录里，卸载时删除即可；已装有合适的 Node.js 时会直接使用。",
	},
	en: {
		title: "Set up the runtime first",
		intro: "To keep the installer small, Prometheus no longer ships Node.js or its agent engine (PI Agent). Install them here in one click the first time you use it. It only has to be done once; they are updated along with the app.",
		node: "Node.js 22",
		nodeDesc: "Runs the backend, includes npm (about 35 MB)",
		pi: "PI Agent",
		piDesc: "The default agent engine and its model library (about 70 MB, installed with npm)",
		done: "Ready",
		pending: "Not installed",
		install: "Install",
		retry: "Retry",
		cancel: "Cancel",
		starting: "Installed, starting the backend…",
		remote: "Use a remote server instead",
		note: "Needs internet access. Everything goes into the app's own data folder and can be deleted to uninstall; a suitable Node.js already on this machine is used as is.",
	},
});

/**
 * Shown instead of the connect screen when the local backend cannot start because the installer left something out
 * (Node.js, the PI agent). One button installs what is missing; when it finishes the backend is started again.
 */
export function SetupScreen({ missing, onReady, onRemote }: { missing: SetupComponent[]; onReady: () => void; onRemote: () => void }) {
	const t = useT(M);
	const jobs = useRuntimes((s) => s.jobs);
	const [starting, setStarting] = useState(false);
	// Installing the PI agent installs Node.js first when it is missing, so one job covers both.
	const target: SetupComponent = missing.includes("pi-agent") ? "pi-agent" : "node";
	const job = jobs[target];
	const running = !!job && !job.finished;
	const failed = !!job && job.finished && !job.ok;

	useEffect(() => {
		void initRuntimes();
	}, []);

	useEffect(() => {
		if (job?.finished && job.ok && !starting) {
			setStarting(true);
			onReady();
		}
	}, [job?.finished, job?.ok, starting, onReady]);

	const rows: { id: SetupComponent; name: string; desc: string }[] = [
		{ id: "node", name: t("node"), desc: t("nodeDesc") },
		{ id: "pi-agent", name: t("pi"), desc: t("piDesc") },
	];

	return (
		<div className="flex h-full items-center justify-center overflow-y-auto px-4 py-8">
			<div className="w-full max-w-lg space-y-5 rounded-2xl border border-ink-800 bg-ink-900/80 p-6 shadow-2xl shadow-black/40 backdrop-blur">
				<div className="flex items-center gap-3">
					<Flame className="size-9" />
					<h1 className="font-display text-xl font-semibold text-ink-100">{t("title")}</h1>
				</div>
				<p className="text-sm leading-relaxed text-ink-400">{t("intro")}</p>
				<ul className="space-y-2">
					{rows.map((r) => {
						const need = missing.includes(r.id);
						return (
							<li key={r.id} className="flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-950/50 px-3.5 py-2.5">
								{need ? <Circle className="size-4 shrink-0 text-ink-500" /> : <Check className="size-4 shrink-0 text-moss-400" />}
								<span className="min-w-0 flex-1">
									<span className="block text-sm text-ink-100">{r.name}</span>
									<span className="block text-xs text-ink-500">{r.desc}</span>
								</span>
								<span className="shrink-0 text-xs text-ink-400">{need ? t("pending") : t("done")}</span>
							</li>
						);
					})}
				</ul>
				{job && !starting && <JobView job={job} />}
				{starting && (
					<div className="flex items-center gap-2 text-sm text-ink-300">
						<LoaderCircle className="size-4 animate-spin" /> {t("starting")}
					</div>
				)}
				{!starting && (
					<div className="flex flex-wrap items-center gap-2">
						{running ? (
							<Button variant="outline" onClick={() => void cancelRuntime(target)}>
								{t("cancel")}
							</Button>
						) : (
							<Button variant="primary" onClick={() => void installRuntime(target)}>
								<Download className="size-4" /> {failed ? t("retry") : t("install")}
							</Button>
						)}
						<Button variant="ghost" onClick={onRemote} disabled={running}>
							{t("remote")}
						</Button>
					</div>
				)}
				<p className="text-xs leading-relaxed text-ink-500">{t("note")}</p>
			</div>
		</div>
	);
}
