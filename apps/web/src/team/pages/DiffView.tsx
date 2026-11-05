import clsx from "clsx";
import { FileDiff } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { displayPath, type DiffFile, type DiffLine, parseUnifiedDiff } from "../diff.ts";
import type { MergeRequestDiff } from "../types.ts";

const M = defineMessages({
	zh: {
		files: "变更文件（{count}）",
		binary: "二进制文件",
		binaryBody: "二进制文件，不显示内容差异。",
		added: "新增",
		deleted: "删除",
		modified: "修改",
		renamed: "重命名",
		truncated: "差异过大，已截断显示。",
		empty: "没有文件变更",
		noHunks: "没有内容变化",
		renamedFrom: "原路径 {path}",
		jump: "跳转到 {path}",
	},
	en: {
		files: "Changed files ({count})",
		binary: "Binary",
		binaryBody: "Binary file, no content diff shown.",
		added: "Added",
		deleted: "Deleted",
		modified: "Modified",
		renamed: "Renamed",
		truncated: "The diff is large and was truncated.",
		empty: "No file changes",
		noHunks: "No content changes",
		renamedFrom: "Renamed from {path}",
		jump: "Jump to {path}",
	},
});

const anchor = (i: number) => `team-diff-file-${i}`;

const ROW: Record<DiffLine["type"], string> = {
	add: "bg-moss-400/10",
	del: "bg-rose-400/10",
	ctx: "",
	meta: "text-ink-500 italic",
};
const SIGN: Record<DiffLine["type"], string> = { add: "+", del: "-", ctx: " ", meta: "" };

function FileBlock({ file, index }: { file: DiffFile; index: number }) {
	const t = useT(M);
	const path = displayPath(file);
	return (
		<section id={anchor(index)} aria-label={path} className="scroll-mt-4 overflow-hidden rounded-xl border border-ink-700">
			<header className="flex flex-wrap items-center gap-2 border-b hairline bg-ink-850 px-3 py-2">
				<span className="min-w-0 flex-1 break-all font-mono text-xs font-medium">{path}</span>
				<Badge tone={file.status === "added" ? "moss" : file.status === "deleted" ? "rose" : file.status === "renamed" ? "sky" : "muted"}>{t(file.status)}</Badge>
				{file.binary ? (
					<Badge tone="ember">{t("binary")}</Badge>
				) : (
					<span className="font-mono text-xs">
						<span className="text-moss-400">+{file.additions}</span> <span className="text-rose-400">-{file.deletions}</span>
					</span>
				)}
			</header>
			{file.status === "renamed" && <p className="border-b hairline px-3 py-1.5 text-xs text-ink-400">{t("renamedFrom", { path: file.oldPath })}</p>}
			{file.binary ? (
				<p className="px-3 py-3 text-sm text-ink-400">{t("binaryBody")}</p>
			) : file.hunks.length === 0 ? (
				<p className="px-3 py-3 text-sm text-ink-400">{t("noHunks")}</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full border-collapse font-mono text-xs leading-5">
						<tbody>
							{file.hunks.map((h, hi) => (
								<HunkRows key={`${h.header}-${hi}`} header={h.header} lines={h.lines} />
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

function HunkRows({ header, lines }: { header: string; lines: DiffLine[] }) {
	return (
		<>
			<tr className="bg-sky-400/8 text-sky-400">
				<td colSpan={4} className="px-3 py-0.5">
					{header}
				</td>
			</tr>
			{lines.map((l, i) => (
				<tr key={i} className={clsx(ROW[l.type])}>
					<td className="w-12 select-none px-2 text-right text-ink-500">{l.oldNo ?? ""}</td>
					<td className="w-12 select-none px-2 text-right text-ink-500">{l.newNo ?? ""}</td>
					<td aria-hidden className="w-4 select-none text-center text-ink-500">
						{SIGN[l.type]}
					</td>
					<td className="whitespace-pre pr-3">{l.text}</td>
				</tr>
			))}
		</>
	);
}

/** File list (with binary markers and counts) above the unified diff of every file. */
export function DiffView({ diff }: { diff: MergeRequestDiff }) {
	const t = useT(M);
	const files = useMemo(() => parseUnifiedDiff(diff.diff), [diff.diff]);
	// The Hub's numstat knows about binaries even when the text diff of a file was cut off.
	const binaryPaths = useMemo(() => new Set(diff.files.filter((f) => f.binary).map((f) => f.path)), [diff.files]);
	const shown = useMemo(() => files.map((f) => (binaryPaths.has(displayPath(f)) ? { ...f, binary: true } : f)), [files, binaryPaths]);

	if (shown.length === 0 && diff.files.length === 0) {
		return <p className="py-6 text-center text-sm text-ink-400">{t("empty")}</p>;
	}
	return (
		<div className="space-y-4">
			<nav aria-label={t("files", { count: diff.files.length || shown.length })}>
				<h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-300">
					<FileDiff className="size-3.5" aria-hidden /> {t("files", { count: diff.files.length || shown.length })}
				</h3>
				<ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-700 text-sm">
					{(diff.files.length ? diff.files : shown.map((f) => ({ path: displayPath(f), status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary }))).map((f) => {
						const idx = shown.findIndex((s) => displayPath(s) === f.path);
						return (
							<li key={f.path} className="flex items-center gap-2 px-3 py-1.5">
								{idx >= 0 ? (
									<a href={`#${anchor(idx)}`} aria-label={t("jump", { path: f.path })} onClick={(e) => {
										e.preventDefault();
										document.getElementById(anchor(idx))?.scrollIntoView({ block: "start" });
									}} className="min-w-0 flex-1 break-all font-mono text-xs hover:text-ember-300">
										{f.path}
									</a>
								) : (
									<span className="min-w-0 flex-1 break-all font-mono text-xs">{f.path}</span>
								)}
								{f.binary ? (
									<Badge tone="ember">{t("binary")}</Badge>
								) : (
									<span className="font-mono text-xs">
										<span className="text-moss-400">+{f.additions ?? 0}</span> <span className="text-rose-400">-{f.deletions ?? 0}</span>
									</span>
								)}
							</li>
						);
					})}
				</ul>
			</nav>
			{diff.truncated && <p role="status" className="rounded-lg bg-ember-500/10 px-3 py-2 text-sm text-ember-300">{t("truncated")}</p>}
			{shown.map((f, i) => (
				<FileBlock key={`${f.oldPath}->${f.newPath}`} file={f} index={i} />
			))}
		</div>
	);
}
