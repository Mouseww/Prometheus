import type { OptionalPackageInfo } from "@prometheus/protocol";
import { Download, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call, callNewer, refreshRuntimes, useStore } from "../lib/store.ts";
import { Button } from "./ui.tsx";

const M = defineMessages({
	zh: {
		lancedb: "向量检索需要 LanceDB 组件，安装包不再自带它（约 {n} MB，通过 npm 安装到 Prometheus 自己的目录，装好立即可用）。没装时知识库只能建库、不能做向量检索。",
		"claude-agent-sdk": "Claude Code 需要 Claude Agent SDK 组件，安装包不再自带它（约 {n} MB）。",
		install: "安装",
		installing: "安装中，请稍候…",
		noNpm: "找不到 npm，无法一键安装：请先安装 Node.js。",
	},
	en: {
		lancedb: "Vector search needs the LanceDB component, which the installer no longer carries (about {n} MB, installed with npm into Prometheus' own folder and usable right away). Without it you can create knowledge bases but not search them by vector.",
		"claude-agent-sdk": "Claude Code needs the Claude Agent SDK component, which the installer no longer carries (about {n} MB).",
		install: "Install",
		installing: "Installing, please wait…",
		noNpm: "npm was not found, so there is no one-click install. Install Node.js first.",
	},
});

/** A banner offering to install an on-demand package; renders nothing when it is already usable (or the server predates this). */
export function OptionalPackageNotice({ id, onInstalled }: { id: OptionalPackageInfo["id"]; onInstalled?: () => void }) {
	const t = useT(M);
	const conn = useStore((s) => s.conn);
	const [info, setInfo] = useState<OptionalPackageInfo | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (conn !== "open") return;
		void callNewer("package.optionalList", (c) => c.rpc("package.optionalList", {})).then((list) => setInfo(list?.find((p) => p.id === id) ?? null));
	}, [id, conn]);

	if (!info || info.installed) return null;

	const install = async () => {
		setBusy(true);
		try {
			const next = await call((c) => c.rpc("package.optionalInstall", { id }));
			if (next) {
				setInfo(next);
				await refreshRuntimes();
				if (next.installed) onInstalled?.();
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-wrap items-center gap-3 border-b border-ember-500/20 bg-ember-500/8 px-4 py-2.5 text-xs text-ember-100">
			<span className="min-w-0 flex-1 leading-relaxed">{info.installable ? t(id, { n: info.sizeMb }) : t("noNpm")}</span>
			{info.installable && (
				<Button variant="primary" className="px-2.5 py-1 text-xs" disabled={busy} onClick={() => void install()}>
					{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} {busy ? t("installing") : t("install")}
				</Button>
			)}
		</div>
	);
}
