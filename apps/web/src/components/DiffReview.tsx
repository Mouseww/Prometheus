import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { GitChangedFile, GitDiff } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";

const M = defineMessages({
	zh: {
		loading: "加载中…",
		truncated: "（差异过长，已截断）",
		noDiff: "没有可显示的差异（可能是二进制文件）",
		pickFile: "选择一个文件查看差异",
		noFiles: "没有文件变更",
		close: "关闭",
		files: "{n} 个文件",
	},
	en: {
		loading: "Loading…",
		truncated: "(diff too long, truncated)",
		noDiff: "No diff to show (binary file?)",
		pickFile: "Select a file to see its diff",
		noFiles: "No file changes",
		close: "Close",
		files: "{n} files",
	},
});

const LETTER: Record<string, string> = { M: "text-ember-300", A: "text-moss-400", D: "text-rose-400", T: "text-sky-400" };

export function DiffView({ diff }: { diff: GitDiff | null }) {
	const t = useT(M);
	if (!diff) return <p className="p-4 text-sm text-ink-500">{t("loading")}</p>;
	if (!diff.text.trim()) return <p className="p-4 text-sm text-ink-500">{t("noDiff")}</p>;
	return (
		<pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
			{diff.text.split("\n").map((line, i) => (
				<div
					key={i}
					className={clsx(
						"px-1 whitespace-pre",
						line.startsWith("+") && !line.startsWith("+++") && "bg-moss-400/10 text-moss-400",
						line.startsWith("-") && !line.startsWith("---") && "bg-rose-400/10 text-rose-400",
						line.startsWith("@@") && "text-sky-400",
						(line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) && "text-ink-500",
					)}
				>
					{line || " "}
				</div>
			))}
			{diff.truncated && <div className="px-1 pt-2 text-ink-500">{t("truncated")}</div>}
		</pre>
	);
}

export function LineCounts({ added, deleted, binary }: { added: number; deleted: number; binary?: boolean }) {
	if (binary) return <span className="font-mono text-[11px] text-ink-500">bin</span>;
	return (
		<span className="shrink-0 font-mono text-[11px]">
			<span className="text-moss-400">+{added}</span> <span className="text-rose-400">-{deleted}</span>
		</span>
	);
}

/**
 * Full-screen review window: changed files on the left, the chosen file's diff on the right.
 * `loadDiff` should be stable (useCallback) because a new function reloads the open diff.
 */
export function DiffReview({
	title,
	subtitle,
	toolbar,
	files,
	initial,
	loadDiff,
	onClose,
}: {
	title: string;
	subtitle?: ReactNode;
	toolbar?: ReactNode;
	files: GitChangedFile[] | null;
	initial?: string;
	loadDiff: (path: string) => Promise<GitDiff | undefined>;
	onClose: () => void;
}) {
	const t = useT(M);
	const [picked, setPicked] = useState<string | undefined>(initial);
	const [diff, setDiff] = useState<GitDiff | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Keep a valid selection: the first file unless the opener asked for one, and a new one when the list changes under us.
	useEffect(() => {
		if (!files || files.length === 0) return setPicked(undefined);
		if (!picked || !files.some((f) => f.path === picked)) setPicked(files[0]?.path);
	}, [files, picked]);

	useEffect(() => {
		if (!picked) return setDiff(null);
		let live = true;
		setDiff(null);
		void loadDiff(picked).then((d) => live && setDiff(d ?? { text: "", truncated: false }));
		return () => {
			live = false;
		};
	}, [picked, loadDiff]);

	const totals = (files ?? []).reduce((a, f) => ({ added: a.added + f.added, deleted: a.deleted + f.deleted }), { added: 0, deleted: 0 });

	return createPortal(
		<div className="fixed inset-0 z-[60] grid place-items-center bg-ink-950/60 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-sm md:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div role="dialog" aria-modal className="@container flex h-full w-full max-w-6xl animate-rise flex-col overflow-hidden border-ink-700 bg-ink-900 shadow-2xl shadow-black/60 md:max-h-[52rem] md:rounded-2xl md:border">
				<header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b hairline px-4 py-3">
					<div className="min-w-0 flex-1">
						<h2 className="truncate font-display text-base font-semibold text-ink-100">{title}</h2>
						<div className="flex flex-wrap items-center gap-x-3 text-xs text-ink-500">
							{subtitle}
							{files && files.length > 0 && (
								<span className="flex items-center gap-2">
									{t("files", { n: files.length })} <LineCounts {...totals} />
								</span>
							)}
						</div>
					</div>
					{toolbar}
					<button type="button" onClick={onClose} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-800 hover:text-ink-100" aria-label={t("close")} title={t("close")}>
						<X className="size-4" />
					</button>
				</header>
				<div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] @3xl:grid-cols-[minmax(240px,320px)_1fr] @3xl:grid-rows-1">
					<ul className="min-h-0 overflow-y-auto border-b hairline p-2 @3xl:border-r @3xl:border-b-0">
						{files === null && <li className="p-3 text-sm text-ink-500">{t("loading")}</li>}
						{files?.length === 0 && <li className="p-3 text-sm text-ink-500">{t("noFiles")}</li>}
						{files?.map((f) => {
							const slash = Math.max(f.path.lastIndexOf("/"), f.path.lastIndexOf("\\"));
							return (
								<li key={f.path}>
									<button
										type="button"
										onClick={() => setPicked(f.path)}
										title={f.path}
										className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]", picked === f.path ? "bg-ink-800 text-ink-100" : "text-ink-300 hover:bg-ink-850")}
									>
										<span className={clsx("w-3 shrink-0 text-center font-mono text-xs", LETTER[f.status] ?? "text-ink-400")}>{f.status}</span>
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
					<div className="flex min-h-0 min-w-0 flex-col">
						{picked ? (
							<>
								<div className="truncate border-b hairline px-4 py-2 font-mono text-xs text-ink-300">{picked}</div>
								<DiffView diff={diff} />
							</>
						) : (
							<div className="grid flex-1 place-items-center text-sm text-ink-500">{t("pickFile")}</div>
						)}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
