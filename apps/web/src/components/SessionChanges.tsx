import clsx from "clsx";
import { ChevronRight, FileDiff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitChangedFile, GitDiff } from "@prometheus/protocol";
import { editedPaths, gitQuiet } from "../lib/git.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { onPluginChange, pluginActive, useStore } from "../lib/store.ts";
import { DiffReview, LineCounts } from "./DiffReview.tsx";
import { Collapse } from "./ui.tsx";

const M = defineMessages({
	zh: { changed: "本对话修改了 {n} 个文件", review: "审查全部", title: "本对话的文件变更", vsHead: "相对 HEAD 的未提交变更" },
	en: { changed: "{n} files changed in this chat", review: "Review all", title: "Changes in this chat", vsHead: "Uncommitted changes against HEAD" },
});

/** Files the agent touched in this conversation (collapsed by default) with +/- line counts; opens a diff review. */
export function SessionChanges() {
	const t = useT(M);
	const enabled = useStore((s) => pluginActive(s.plugins, "git"));
	const path = useStore((s) => s.workspaces.find((w) => w.id === s.session?.workspaceId)?.path);
	const messages = useStore((s) => s.session?.messages);
	const cwd = useStore((s) => s.session?.cwd);
	const streaming = useStore((s) => s.session?.isStreaming ?? false);
	const [files, setFiles] = useState<GitChangedFile[]>([]);
	const [open, setOpen] = useState(false);
	const [review, setReview] = useState<{ initial?: string } | null>(null);

	const paths = useMemo(() => (messages ? editedPaths(messages) : []), [messages]);
	// A stable key: the message list changes on every streamed token, the set of edited files rarely.
	const key = paths.join("\n");

	const refresh = useCallback(async () => {
		if (!enabled || !path || key === "") return setFiles([]);
		setFiles((await gitQuiet<GitChangedFile[]>(path, "changes", { paths: key.split("\n"), cwd })) ?? []);
	}, [enabled, path, cwd, key]);

	useEffect(() => {
		const timer = setTimeout(() => void refresh(), streaming ? 800 : 0);
		return () => clearTimeout(timer);
	}, [refresh, streaming]);
	useEffect(() => onPluginChange("git", () => void refresh()), [refresh]);

	const loadDiff = useCallback((p: string) => gitQuiet<GitDiff>(path, "fileDiff", { path: p }), [path]);

	if (files.length === 0) return null;
	const totals = files.reduce((a, f) => ({ added: a.added + f.added, deleted: a.deleted + f.deleted }), { added: 0, deleted: 0 });

	return (
		<div className="mb-2 overflow-hidden rounded-xl border border-ink-800 bg-ink-900/60">
			<div className="flex items-center">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-300 transition-colors hover:text-ink-100"
				>
					<ChevronRight className={clsx("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
					<FileDiff className="size-3.5 shrink-0 text-ember-400" />
					<span className="truncate">{t("changed", { n: files.length })}</span>
					<LineCounts {...totals} />
				</button>
				<button type="button" onClick={() => setReview({})} className="shrink-0 px-3 py-1.5 text-xs text-ember-300 hover:underline">
					{t("review")}
				</button>
			</div>
			<Collapse open={open}>
				<ul className="max-h-48 overflow-y-auto border-t border-ink-800 p-1">
					{files.map((f) => {
						const slash = Math.max(f.path.lastIndexOf("/"), f.path.lastIndexOf("\\"));
						return (
							<li key={f.path}>
								<button
									type="button"
									onClick={() => setReview({ initial: f.path })}
									title={f.path}
									className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-ink-300 hover:bg-ink-800 hover:text-ink-100"
								>
									<span className="min-w-0 flex-1 truncate">
										{f.path.slice(slash + 1)}
										{slash >= 0 && <span className="ml-1.5 text-[11px] text-ink-500">{f.path.slice(0, slash)}</span>}
									</span>
									<LineCounts added={f.added} deleted={f.deleted} binary={f.binary} />
								</button>
							</li>
						);
					})}
				</ul>
			</Collapse>
			{review && <DiffReview title={t("title")} subtitle={t("vsHead")} files={files} initial={review.initial} loadDiff={loadDiff} onClose={() => setReview(null)} />}
		</div>
	);
}
