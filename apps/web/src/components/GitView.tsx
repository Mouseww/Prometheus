import clsx from "clsx";
import { confirmDialog, promptDialog } from "../lib/dialogs.ts";
import { ArrowDown, ArrowUp, GitBranch, GitCommitHorizontal, GitCompareArrows, LoaderCircle, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitBranch as Branch, GitChangedFile, GitCommit, GitDiff, GitFileChange, GitRange, GitStatus } from "@prometheus/protocol";
import { defineMessages, relativeTime, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { onPluginChange, pluginCall, toast, useStore } from "../lib/store.ts";
import { DiffReview, DiffView } from "./DiffReview.tsx";
import { Badge, Button, Empty, PageHeader, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "Git",
		subtitle: "查看改动、暂存、提交、切换分支与同步",
		workspace: "工作区",
		noWorkspace: "先在侧栏添加一个工作区",
		notRepo: "这个文件夹还不是 Git 仓库",
		init: "初始化仓库",
		refresh: "刷新",
		staged: "已暂存",
		changes: "未暂存的更改",
		clean: "工作区很干净",
		stage: "暂存",
		unstage: "取消暂存",
		discard: "丢弃更改",
		stageAll: "全部暂存",
		confirmDiscard: "丢弃「{path}」的更改？此操作无法撤销。",
		confirmDiscardNew: "删除未跟踪文件「{path}」？此操作无法撤销。",
		commitPlaceholder: "提交说明",
		commit: "提交 ({n})",
		committed: "已提交 {hash}",
		nothingStaged: "没有已暂存的更改",
		branch: "分支",
		newBranch: "新建分支…",
		branchName: "新分支名称",
		switched: "已切换到 {name}",
		fetch: "获取",
		pull: "拉取",
		push: "推送",
		history: "最近提交",
		noCommits: "还没有提交",
		pickFile: "选择一个文件查看差异",
		loading: "加载中…",
		truncated: "（差异过长，已截断）",
		noDiff: "没有可显示的差异（可能是二进制文件）",
		detached: "游离 HEAD",
		conflict: "冲突",
		ahead: "领先 {n}",
		behind: "落后 {n}",
		busy: "处理中…",
		branchChanges: "分支变更",
		branchChangesHint: "查看此分支相对基线的变更文件",
		compareWith: "对比基线",
		autoBase: "自动（main/master）",
		viewCommit: "查看此提交的变更文件",
	},
	en: {
		title: "Git",
		subtitle: "Review changes, stage, commit, switch branches and sync",
		workspace: "Workspace",
		noWorkspace: "Add a workspace in the sidebar first",
		notRepo: "This folder is not a Git repository yet",
		init: "Initialize repository",
		refresh: "Refresh",
		staged: "Staged",
		changes: "Unstaged changes",
		clean: "Working tree clean",
		stage: "Stage",
		unstage: "Unstage",
		discard: "Discard changes",
		stageAll: "Stage all",
		confirmDiscard: "Discard changes to \"{path}\"? This cannot be undone.",
		confirmDiscardNew: "Delete untracked file \"{path}\"? This cannot be undone.",
		commitPlaceholder: "Commit message",
		commit: "Commit ({n})",
		committed: "Committed {hash}",
		nothingStaged: "Nothing staged",
		branch: "Branch",
		newBranch: "New branch…",
		branchName: "New branch name",
		switched: "Switched to {name}",
		fetch: "Fetch",
		pull: "Pull",
		push: "Push",
		history: "Recent commits",
		noCommits: "No commits yet",
		pickFile: "Select a file to see its diff",
		loading: "Loading…",
		truncated: "(diff too long, truncated)",
		noDiff: "No diff to show (binary file?)",
		detached: "Detached HEAD",
		conflict: "Conflict",
		ahead: "ahead {n}",
		behind: "behind {n}",
		busy: "Working…",
		branchChanges: "Branch changes",
		branchChangesHint: "Files this branch changed against its base",
		compareWith: "Compare with",
		autoBase: "Auto (main/master)",
		viewCommit: "View files changed in this commit",
	},
});

const LETTER: Record<string, string> = { M: "text-ember-300", A: "text-moss-400", D: "text-rose-400", R: "text-sky-400", C: "text-sky-400", U: "text-rose-400", "?": "text-moss-400" };

type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function CommitReview({ commit, call, onClose }: { commit: GitCommit; call: Call; onClose: () => void }) {
	const [files, setFiles] = useState<GitChangedFile[] | null>(null);
	useEffect(() => {
		let live = true;
		void call("commitFiles", { hash: commit.hash }).then((r) => live && setFiles((r as GitChangedFile[] | undefined) ?? []));
		return () => {
			live = false;
		};
	}, [call, commit.hash]);
	const loadDiff = useCallback((path: string) => call("commitDiff", { hash: commit.hash, path }) as Promise<GitDiff | undefined>, [call, commit.hash]);
	return (
		<DiffReview
			title={commit.subject}
			subtitle={
				<span className="font-mono">
					{commit.short} · {commit.author}
				</span>
			}
			files={files}
			loadDiff={loadDiff}
			onClose={onClose}
		/>
	);
}

function BranchReview({ current, branches, call, onClose }: { current?: string; branches: Branch[]; call: Call; onClose: () => void }) {
	const t = useT(M);
	const [base, setBase] = useState("");
	const [range, setRange] = useState<GitRange | null>(null);
	useEffect(() => {
		let live = true;
		setRange(null);
		void call("rangeFiles", { base }).then((r) => live && setRange((r as GitRange | undefined) ?? { base, files: [] }));
		return () => {
			live = false;
		};
	}, [call, base]);
	const used = range?.base || base;
	const loadDiff = useCallback((path: string) => call("rangeDiff", { base: used, path }) as Promise<GitDiff | undefined>, [call, used]);
	return (
		<DiffReview
			title={t("branchChanges")}
			subtitle={<span className="font-mono">{used ? `${used}...${current ?? "HEAD"}` : current}</span>}
			toolbar={
				<label className="flex items-center gap-2 text-xs text-ink-400">
					{t("compareWith")}
					<Select value={base} onChange={(e) => setBase(e.target.value)} className="w-44 py-1 text-xs">
						<option value="">{t("autoBase")}</option>
						{branches
							.filter((b) => b.name !== current)
							.map((b) => (
								<option key={`${b.remote}${b.name}`} value={b.name}>
									{b.name}
								</option>
							))}
					</Select>
				</label>
			}
			files={range?.files ?? null}
			loadDiff={loadDiff}
			onClose={onClose}
		/>
	);
}

export function GitView() {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const workspaces = useStore((s) => s.workspaces);
	const activeWorkspace = useStore((s) => s.session?.workspaceId);
	const [wsId, setWsId] = useState<string>("");
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [commits, setCommits] = useState<GitCommit[]>([]);
	const [branches, setBranches] = useState<Branch[]>([]);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [picked, setPicked] = useState<{ file: GitFileChange; staged: boolean } | null>(null);
	const [diff, setDiff] = useState<GitDiff | null>(null);
	const [review, setReview] = useState<{ commit: GitCommit } | "branch" | null>(null);

	// Default to the workspace of the open chat, else the newest one.
	useEffect(() => {
		if (wsId && workspaces.some((w) => w.id === wsId)) return;
		setWsId((workspaces.find((w) => w.id === activeWorkspace) ?? workspaces[0])?.id ?? "");
	}, [workspaces, activeWorkspace, wsId]);

	const path = workspaces.find((w) => w.id === wsId)?.path;

	const call = useCallback((method: string, params: Record<string, unknown> = {}) => pluginCall<unknown>("git", method, { workspace: path, ...params }), [path]);

	const refresh = useCallback(async () => {
		if (!path) return;
		const st = (await call("status")) as GitStatus | undefined;
		if (!st) return;
		setStatus(st);
		if (!st.isRepo) {
			setCommits([]);
			setBranches([]);
			return;
		}
		const [log, br] = await Promise.all([call("log", { limit: 30 }), call("branches")]);
		setCommits((log as GitCommit[] | undefined) ?? []);
		setBranches((br as Branch[] | undefined) ?? []);
	}, [call, path]);

	useEffect(() => {
		setStatus(null);
		setPicked(null);
		void refresh();
	}, [refresh]);

	useEffect(() => onPluginChange("git", () => void refresh()), [refresh]);

	// Reload the diff when the chosen file changes, and drop the selection if the file left the list.
	useEffect(() => {
		if (!picked || !status) return;
		const still = status.files.find((f) => f.path === picked.file.path);
		if (!still) {
			setPicked(null);
			return;
		}
		setDiff(null);
		let live = true;
		void call("diff", { path: picked.file.path, staged: picked.staged, untracked: picked.file.index === "?" }).then((d) => live && setDiff((d as GitDiff | undefined) ?? { text: "", truncated: false }));
		return () => {
			live = false;
		};
	}, [picked?.file.path, picked?.staged, status, call]);

	const act = async (fn: () => Promise<unknown>, done?: string) => {
		setBusy(true);
		const res = await fn();
		setBusy(false);
		if (res !== undefined) {
			if (done) toast(done);
			await refresh();
		}
		return res;
	};

	const files = status?.files ?? [];
	const staged = useMemo(() => files.filter((f) => f.index !== " " && f.index !== "?" && f.index !== "U"), [files]);
	const unstaged = useMemo(() => files.filter((f) => f.worktree !== " " || f.index === "?" || f.index === "U"), [files]);

	const row = (f: GitFileChange, isStaged: boolean) => {
		const letter = isStaged ? f.index : f.worktree === " " ? f.index : f.worktree;
		const on = picked?.file.path === f.path && picked.staged === isStaged;
		const name = f.path.split("/").pop();
		const dir = f.path.slice(0, f.path.length - (name?.length ?? 0));
		return (
			<li key={`${isStaged}:${f.path}`} className={clsx("group flex items-center gap-2 rounded-md px-2 py-1 text-[13px]", on ? "bg-ink-800" : "hover:bg-ink-850")}>
				<button type="button" onClick={() => setPicked({ file: f, staged: isStaged })} className="flex min-w-0 flex-1 items-center gap-2 text-left">
					<span className={clsx("w-3 shrink-0 text-center font-mono text-xs font-bold", LETTER[letter] ?? "text-ink-400")} title={letter === "U" ? t("conflict") : undefined}>
						{letter === "?" ? "U" : letter}
					</span>
					<span className="min-w-0 truncate">
						<span className="text-ink-100">{name}</span>
						{dir && <span className="ml-1.5 text-ink-500">{dir}</span>}
					</span>
				</button>
				<span className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 nohover:opacity-100">
					{isStaged ? (
						<button type="button" title={t("unstage")} className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" onClick={() => void act(() => call("unstage", { paths: [f.path] }))}>
							<Minus className="size-3.5" />
						</button>
					) : (
						<>
							<button
								type="button"
								title={t("discard")}
								className="rounded p-1 text-ink-400 hover:bg-rose-400/10 hover:text-rose-400"
								onClick={() => {
									const untracked = f.index === "?";
									void confirmDialog(t(untracked ? "confirmDiscardNew" : "confirmDiscard", { path: f.path })).then((ok) => { if (ok) void act(() => call("discard", { files: [{ path: f.path, untracked }] })); });
								}}
							>
								<Undo2 className="size-3.5" />
							</button>
							<button type="button" title={t("stage")} className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" onClick={() => void act(() => call("stage", { paths: [f.path] }))}>
								<Plus className="size-3.5" />
							</button>
						</>
					)}
				</span>
			</li>
		);
	};

	const local = branches.filter((b) => !b.remote);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<div className="flex items-center gap-2">
						{workspaces.length > 0 && (
							<Select value={wsId} onChange={(e) => setWsId(e.target.value)} aria-label={t("workspace")} className="w-36 py-1.5 md:w-48">
								{workspaces.map((w) => (
									<option key={w.id} value={w.id}>
										{w.name}
									</option>
								))}
							</Select>
						)}
						<Button variant="outline" onClick={() => void act(refresh)} disabled={!path || busy} title={t("refresh")}>
							<RefreshCw className={clsx("size-4", busy && "animate-spin")} />
						</Button>
					</div>
				}
			/>

			{workspaces.length === 0 ? (
				<Empty icon={<GitBranch className="size-5" />} title={t("noWorkspace")} />
			) : !status ? (
				<div className="grid flex-1 place-items-center text-ink-500">
					<LoaderCircle className="size-5 animate-spin" />
				</div>
			) : !status.isRepo ? (
				<Empty icon={<GitBranch className="size-5" />} title={t("notRepo")}>
					<Button variant="primary" className="mt-2" disabled={busy} onClick={() => void act(() => call("init"))}>
						{t("init")}
					</Button>
				</Empty>
			) : (
				<div className={clsx("grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(300px,380px)_1fr] md:grid-rows-1", picked ? "grid-rows-[minmax(0,3fr)_minmax(0,2fr)]" : "grid-rows-[minmax(0,1fr)]")}>
					<div className="flex min-h-0 flex-col border-b hairline md:border-r md:border-b-0">
						<div className="flex flex-wrap items-center gap-2 border-b hairline px-4 py-3">
							<GitBranch className="size-4 shrink-0 text-ember-400" />
							{status.detached ? (
								<Badge tone="rose">{t("detached")}</Badge>
							) : (
								<Select
									value={status.branch ?? ""}
									aria-label={t("branch")}
									className="min-w-0 flex-1 py-1 text-xs"
									onChange={(e) => {
										const name = e.target.value;
										if (name === "__new") {
											void promptDialog(t("branchName")).then((n) => { if (n) void act(() => call("checkout", { name: n, create: true }), t("switched", { name: n })); });
										} else void act(() => call("checkout", { name }), t("switched", { name }));
									}}
								>
									{local.map((b) => (
										<option key={b.name} value={b.name}>
											{b.name}
										</option>
									))}
									<option value="__new">{t("newBranch")}</option>
								</Select>
							)}
							{!status.detached && (
								<button type="button" title={t("branchChangesHint")} aria-label={t("branchChanges")} className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100" onClick={() => setReview("branch")}>
									<GitCompareArrows className="size-4" />
								</button>
							)}
							{status.ahead > 0 && (
								<span className="flex items-center font-mono text-[11px] text-ink-400" title={t("ahead", { n: status.ahead })}>
									<ArrowUp className="size-3" />
									{status.ahead}
								</span>
							)}
							{status.behind > 0 && (
								<span className="flex items-center font-mono text-[11px] text-ink-400" title={t("behind", { n: status.behind })}>
									<ArrowDown className="size-3" />
									{status.behind}
								</span>
							)}
							<span className="flex gap-1">
								<Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void act(() => call("fetch"))}>
									{t("fetch")}
								</Button>
								<Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void act(() => call("pull"), "OK")}>
									{t("pull")}
								</Button>
								<Button variant="ghost" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void act(() => call("push"), "OK")}>
									{t("push")}
								</Button>
							</span>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
							{files.length === 0 && <p className="px-3 py-6 text-center text-sm text-ink-500">{t("clean")}</p>}
							{staged.length > 0 && (
								<section className="mb-3">
									<h3 className="px-2 pb-1 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">
										{t("staged")} · {staged.length}
									</h3>
									<ul>{staged.map((f) => row(f, true))}</ul>
								</section>
							)}
							{unstaged.length > 0 && (
								<section className="mb-3">
									<h3 className="flex items-center justify-between px-2 pb-1 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">
										<span>
											{t("changes")} · {unstaged.length}
										</span>
										<button type="button" className="normal-case tracking-normal text-ember-300 hover:underline" onClick={() => void act(() => call("stage", { paths: unstaged.map((f) => f.path) }))}>
											{t("stageAll")}
										</button>
									</h3>
									<ul>{unstaged.map((f) => row(f, false))}</ul>
								</section>
							)}
							<section>
								<h3 className="px-2 pb-1 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("history")}</h3>
								{commits.length === 0 ? (
									<p className="px-2 py-2 text-xs text-ink-600">{t("noCommits")}</p>
								) : (
									<ul>
										{commits.map((c) => (
											<li key={c.hash}>
												<button
													type="button"
													onClick={() => setReview({ commit: c })}
													className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-ink-850"
													title={`${c.author} · ${c.hash}
${t("viewCommit")}`}
												>
													<GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-ink-500" />
													<span className="min-w-0 flex-1">
														<span className="block truncate text-ink-200">{c.subject}</span>
														<span className="block truncate font-mono text-[10.5px] text-ink-500">
															{c.short} · {c.author} · {relativeTime(c.date, lang)}
														</span>
													</span>
												</button>
											</li>
										))}
									</ul>
								)}
							</section>
						</div>

						<form
							className="space-y-2 border-t hairline p-3"
							onSubmit={(e) => {
								e.preventDefault();
								if (!staged.length) return toast(t("nothingStaged"), "warning");
								void act(async () => {
									const hash = (await call("commit", { message })) as string | undefined;
									if (hash) {
										setMessage("");
										toast(t("committed", { hash }));
									}
									return hash;
								});
							}}
						>
							<Textarea
								value={message}
								rows={2}
								onChange={(e) => setMessage(e.target.value)}
								placeholder={t("commitPlaceholder")}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
								}}
							/>
							<Button type="submit" variant="primary" className="w-full" disabled={busy || !message.trim() || !staged.length}>
								{t("commit", { n: staged.length })}
							</Button>
						</form>
					</div>

					<div className={clsx("min-h-0 min-w-0 flex-col", picked ? "flex" : "flex max-md:hidden")}>
						{picked ? (
							<>
								<div className="border-b hairline px-4 py-2 font-mono text-xs text-ink-300">{picked.file.path}</div>
								<DiffView diff={diff} />
							</>
						) : (
							<div className="grid flex-1 place-items-center text-sm text-ink-500">{t("pickFile")}</div>
						)}
					</div>
				</div>
			)}
			{review && review !== "branch" && <CommitReview commit={review.commit} call={call} onClose={() => setReview(null)} />}
			{review === "branch" && <BranchReview current={status?.branch} branches={branches} call={call} onClose={() => setReview(null)} />}
		</div>
	);
}
