import { ChevronRight, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import { Empty } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { useTeam } from "../../context.tsx";
import { AsyncView, useAsync } from "../../kit.tsx";
import { decodeBase64Text, joinPath, parentPaths } from "../../logic/files.ts";

const M = defineMessages({
	zh: {
		root: "根目录",
		crumbs: "当前位置",
		empty: "这个目录是空的",
		binary: "二进制文件，无法预览（{size}）",
		submodule: "子模块",
		size: "{n} 字节",
		snapshotHint: "显示的是会话最近一次快照，包含所有者尚未提交的修改。",
	},
	en: {
		root: "Root",
		crumbs: "Current location",
		empty: "This folder is empty",
		binary: "Binary file, no preview ({size})",
		submodule: "submodule",
		size: "{n} bytes",
		snapshotHint: "Shows the latest session snapshot, including work the owner has not committed.",
	},
});

export function FilesTab({ sessionId }: { sessionId: string }) {
	const { api } = useTeam();
	const t = useT(M);
	const [path, setPath] = useState("");
	const listing = useAsync(() => api.browseSessionFiles(sessionId, path || undefined), [api, sessionId, path]);

	return (
		<div className="space-y-3">
			<p className="text-xs text-ink-500">{t("snapshotHint")}</p>
			<nav aria-label={t("crumbs")} className="flex flex-wrap items-center gap-1 text-sm">
				<button type="button" onClick={() => setPath("")} className="rounded px-1.5 py-0.5 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-ember-400">
					{t("root")}
				</button>
				{parentPaths(path).map((p) => (
					<span key={p.path} className="flex items-center gap-1">
						<ChevronRight className="size-3.5 text-ink-500" aria-hidden />
						<button type="button" onClick={() => setPath(p.path)} className="rounded px-1.5 py-0.5 font-mono text-xs hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-ember-400">
							{p.name}
						</button>
					</span>
				))}
			</nav>
			<AsyncView state={listing}>
				{(l) => {
					if (l.type === "file") {
						return l.binary ? (
							<p className="rounded-lg border border-ink-700 p-4 text-sm text-ink-400">{t("binary", { size: t("size", { n: l.size }) })}</p>
						) : (
							<pre className="max-h-[60vh] overflow-auto rounded-lg border border-ink-700 bg-ink-950/60 p-3 font-mono text-xs break-words whitespace-pre-wrap text-ink-200">{decodeBase64Text(l.content)}</pre>
						);
					}
					if (l.entries.length === 0) return <Empty icon={<FolderOpen className="size-5" />} title={t("empty")} />;
					return (
						<ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-700">
							{l.entries.map((e) => (
								<li key={e.name}>
									<button
										type="button"
										disabled={e.type === "submodule"}
										onClick={() => setPath(joinPath(l.path, e.name))}
										className="flex w-full items-center gap-2.5 bg-ink-900/60 px-3 py-2 text-left text-sm transition-colors hover:bg-ink-850 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ember-400 disabled:opacity-60"
									>
										{e.type === "dir" ? <Folder className="size-4 shrink-0 text-ember-300" aria-hidden /> : <FileIcon className="size-4 shrink-0 text-ink-400" aria-hidden />}
										<span className="min-w-0 flex-1 truncate font-mono text-xs">{e.name}</span>
										{e.type === "submodule" && <span className="text-xs text-ink-500">{t("submodule")}</span>}
										{e.type === "file" && e.size !== null && <span className="text-xs text-ink-500">{t("size", { n: e.size })}</span>}
									</button>
								</li>
							))}
						</ul>
					);
				}}
			</AsyncView>
		</div>
	);
}
