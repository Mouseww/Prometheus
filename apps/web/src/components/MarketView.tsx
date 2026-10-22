import clsx from "clsx";
import { confirmDialog } from "../lib/dialogs.ts";
import { ArrowUpCircle, CircleAlert, CircleCheck, Download, ExternalLink, LoaderCircle, Package, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PackageInfo, PackageJob, PackageListing, PackageSearchPage, PackageUpdateInfo } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { dismissPackageJob, pluginCall, refreshPackageJobs, startPackageJob, toast, useStore } from "../lib/store.ts";
import { Badge, Button, Empty, Input, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "PI 插件市场",
		subtitle: "安装 PI 扩展包（工具、技能、提示词模板与主题），与 PI TUI 共享。这不同于“Prometheus 插件”，后者用于扩展本项目自身",
		installedTab: "已安装",
		discoverTab: "发现",
		search: "搜索扩展包…",
		searchBtn: "搜索",
		manual: "或直接安装：npm 包名 / git 地址",
		manualPlaceholder: "npm:@scope/pkg@1.0.0 或 git:github.com/owner/repo",
		install: "安装",
		installing: "安装中…",
		queued: "排队中…",
		installedBadge: "已安装",
		remove: "卸载",
		removing: "卸载中…",
		confirmRemove: "卸载 {name}？",
		update: "更新",
		updateAll: "全部更新",
		updating: "更新中…",
		checkUpdates: "检查更新",
		checking: "检查中…",
		updatesFound: "发现 {n} 个可更新的包",
		noUpdates: "所有包均为最新",
		emptyInstalled: "还没有安装任何扩展包",
		emptyInstalledBody: "到「发现」里挑一个，或粘贴包名直接安装。",
		emptyResults: "没有找到匹配的扩展包",
		notInstalled: "已声明但尚未安装到磁盘",
		loadMore: "加载更多",
		trust: "扩展包以宿主进程权限运行，且可能包含让模型执行程序的技能。只安装可信来源的包，并先查看其源码。",
		filtered: "已筛选",
		unavailable: "无法加载市场",
		retry: "重试",
		total: "共 {n} 个",
		kinds_extensions: "扩展",
		kinds_skills: "技能",
		kinds_prompts: "提示词",
		kinds_themes: "主题",
		tasks: "任务",
		actionInstall: "安装",
		actionRemove: "卸载",
		actionUpdate: "更新",
		allPackages: "全部包",
		succeeded: "完成",
		failed: "失败",
		showLog: "查看输出",
		hideLog: "收起输出",
		dismiss: "清除",
		noOutput: "（暂无输出）",
		elapsed: "{s} 秒",
	},
	en: {
		title: "PI Marketplace",
		subtitle: "Install PI packages (tools, skills, prompt templates and themes), shared with the PI TUI. Not to be confused with Prometheus plugins, which extend this app itself",
		installedTab: "Installed",
		discoverTab: "Discover",
		search: "Search packages…",
		searchBtn: "Search",
		manual: "Or install directly: npm name / git URL",
		manualPlaceholder: "npm:@scope/pkg@1.0.0 or git:github.com/owner/repo",
		install: "Install",
		installing: "Installing…",
		queued: "Queued…",
		installedBadge: "Installed",
		remove: "Remove",
		removing: "Removing…",
		confirmRemove: "Remove {name}?",
		update: "Update",
		updateAll: "Update all",
		updating: "Updating…",
		checkUpdates: "Check for updates",
		checking: "Checking…",
		updatesFound: "{n} package(s) can be updated",
		noUpdates: "Everything is up to date",
		emptyInstalled: "No packages installed yet",
		emptyInstalledBody: "Pick one under Discover, or paste a package name to install it directly.",
		emptyResults: "No matching packages",
		notInstalled: "Declared but not installed on disk yet",
		loadMore: "Load more",
		trust: "Packages run with host process permissions and may ship skills that tell the model to run programs. Only install from sources you trust, and review the source first.",
		filtered: "filtered",
		unavailable: "Could not load the marketplace",
		retry: "Retry",
		total: "{n} total",
		kinds_extensions: "extensions",
		kinds_skills: "skills",
		kinds_prompts: "prompts",
		kinds_themes: "themes",
		tasks: "Tasks",
		actionInstall: "Install",
		actionRemove: "Remove",
		actionUpdate: "Update",
		allPackages: "all packages",
		succeeded: "Done",
		failed: "Failed",
		showLog: "Show output",
		hideLog: "Hide output",
		dismiss: "Dismiss",
		noOutput: "(no output yet)",
		elapsed: "{s}s",
	},
});

type Tab = "installed" | "discover";

const npmName = (source: string): string | undefined => {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4);
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
};

const isActive = (j: PackageJob) => j.status === "queued" || j.status === "running";

function Kinds({ kinds }: { kinds: PackageInfo["kinds"] }) {
	const t = useT(M);
	return (
		<>
			{kinds.map((k) => (
				<Badge key={k} tone="sky">
					{t(`kinds_${k}`)}
				</Badge>
			))}
		</>
	);
}

function JobRow({ job }: { job: PackageJob }) {
	const t = useT(M);
	const [open, setOpen] = useState(job.status === "error");
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!isActive(job)) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [job]);

	const action = t(job.action === "install" ? "actionInstall" : job.action === "remove" ? "actionRemove" : "actionUpdate");
	const name = job.label === "*" ? t("allPackages") : job.label;
	const seconds = Math.max(0, Math.round(((job.finishedAt ?? now) - job.startedAt) / 1000));
	const lines = job.log.slice(-60);

	return (
		<div className={clsx("rounded-xl border p-3", job.status === "error" ? "border-rose-400/40 bg-rose-400/5" : "border-ink-800 bg-ink-900/60")}>
			<div className="flex items-center gap-2 text-sm">
				{job.status === "success" ? (
					<CircleCheck className="size-4 shrink-0 text-moss-400" />
				) : job.status === "error" ? (
					<CircleAlert className="size-4 shrink-0 text-rose-400" />
				) : (
					<LoaderCircle className="size-4 shrink-0 animate-spin text-ember-400" />
				)}
				<span className="font-medium text-ink-100">{action}</span>
				<span className="min-w-0 truncate font-mono text-[13px] text-ink-200" title={job.source}>
					{name}
				</span>
				<span className="shrink-0 text-xs text-ink-500">
					{job.status === "queued" ? t("queued") : job.status === "running" ? t("elapsed", { s: seconds }) : `${job.status === "success" ? t("succeeded") : t("failed")} · ${t("elapsed", { s: seconds })}`}
				</span>
				<span className="ml-auto flex shrink-0 items-center gap-1">
					<Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpen(!open)}>
						{open ? t("hideLog") : t("showLog")}
					</Button>
					{!isActive(job) && (
						<button type="button" onClick={() => void dismissPackageJob(job.id)} className="rounded-md p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100" aria-label={t("dismiss")} title={t("dismiss")}>
							<X className="size-4" />
						</button>
					)}
				</span>
			</div>
			{job.error && <p className="mt-2 break-words text-sm text-rose-300">{job.error}</p>}
			{open && <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-ink-800 bg-ink-950 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-400">{lines.length ? lines.join("\n") : t("noOutput")}</pre>}
		</div>
	);
}

export function MarketView() {
	const t = useT(M);
	const [tab, setTab] = useState<Tab>("installed");
	const [installed, setInstalled] = useState<PackageInfo[]>([]);
	const [updates, setUpdates] = useState<PackageUpdateInfo[]>([]);
	const [checking, setChecking] = useState(false);
	const jobs = useStore((s) => s.packageJobs);
	const revision = useStore((s) => s.packageRevision);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PackageListing[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(0);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState(false);
	const [manual, setManual] = useState("");

	const active = useMemo(() => jobs.filter(isActive), [jobs]);
	const activeFor = useCallback((action: PackageJob["action"], source: string) => active.find((j) => j.action === action && j.source === source), [active]);
	const busy = active.length > 0;

	const loadInstalled = useCallback(async () => {
		const list = await pluginCall<PackageInfo[]>("packages", "list");
		if (list) setInstalled(list);
	}, []);

	const runSearch = useCallback(async (q: string, p: number) => {
		setSearching(true);
		setSearchError(false);
		const res = await pluginCall<PackageSearchPage>("packages", "search", { query: q, page: p });
		setSearching(false);
		if (!res) {
			setSearchError(true);
			return;
		}
		setTotal(res.total);
		setPage(res.page);
		setResults((prev) => (p === 0 ? res.items : [...prev, ...res.items]));
	}, []);

	// Reload the list on mount and whenever a background operation finishes successfully.
	useEffect(() => {
		void loadInstalled();
	}, [loadInstalled, revision]);
	useEffect(() => {
		void refreshPackageJobs();
	}, []);
	useEffect(() => {
		if (revision > 0) setUpdates((u) => u.filter((x) => installed.some((p) => p.source === x.source)));
	}, [installed, revision]);
	useEffect(() => {
		if (tab === "discover" && results.length === 0 && !searching && !searchError) void runSearch(query, 0);
	}, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

	const installedNames = useMemo(() => new Set(installed.flatMap((p) => [npmName(p.source), p.name]).filter(Boolean)), [installed]);
	const updatable = useMemo(() => new Set(updates.map((u) => u.source)), [updates]);

	const install = (source: string, label: string) => startPackageJob("install", { source, label });

	const remove = async (p: PackageInfo) => {
		if (await confirmDialog(t("confirmRemove", { name: p.name }))) void startPackageJob("remove", { source: p.source });
	};

	const update = (source?: string) => startPackageJob("update", source ? { source } : {});

	const check = async () => {
		setChecking(true);
		const res = await pluginCall<PackageUpdateInfo[]>("packages", "checkUpdates");
		setChecking(false);
		if (!res) return;
		setUpdates(res);
		toast(res.length ? t("updatesFound", { n: res.length }) : t("noUpdates"));
	};

	const tabClass = (on: boolean) =>
		`rounded-lg px-3 py-1.5 text-sm transition-colors ${on ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:bg-ink-850 hover:text-ink-100"}`;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					tab === "installed" ? (
						<>
							<Button variant="outline" disabled={checking || installed.length === 0} onClick={() => void check()}>
								{checking ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {checking ? t("checking") : t("checkUpdates")}
							</Button>
							{updates.length > 0 && (
								<Button variant="primary" disabled={busy} onClick={() => void update()}>
									{activeFor("update", "*") ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUpCircle className="size-4" />} {activeFor("update", "*") ? t("updating") : t("updateAll")}
								</Button>
							)}
						</>
					) : undefined
				}
			/>
			<div className="flex gap-1 overflow-x-auto border-b hairline px-4 py-2 @3xl:px-6">
				<button type="button" className={tabClass(tab === "installed")} onClick={() => setTab("installed")}>
					{t("installedTab")}
					{installed.length > 0 && <span className="ml-1.5 font-mono text-[11px] text-ink-500">{installed.length}</span>}
				</button>
				<button type="button" className={tabClass(tab === "discover")} onClick={() => setTab("discover")}>
					{t("discoverTab")}
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4 @3xl:p-6">
				<div className="mx-auto max-w-4xl space-y-5">
					<p className="rounded-lg border border-ember-500/20 bg-ember-500/5 px-3 py-2 text-xs text-ember-200">{t("trust")}</p>

					{jobs.length > 0 && (
						<section className="space-y-2">
							<h2 className="font-mono text-[10.5px] tracking-[0.18em] text-ink-500 uppercase">{t("tasks")}</h2>
							{jobs.map((j) => (
								<JobRow key={j.id} job={j} />
							))}
						</section>
					)}

					{tab === "installed" && (
						<>
							{installed.length === 0 ? (
								<Empty icon={<Package className="size-5" />} title={t("emptyInstalled")}>
									{t("emptyInstalledBody")}
								</Empty>
							) : (
								<div className="space-y-2">
									{installed.map((p) => {
										const removing = activeFor("remove", p.source);
										const updating = activeFor("update", p.source) ?? activeFor("update", "*");
										return (
											<div key={`${p.scope}:${p.source}`} className="animate-rise rounded-xl border border-ink-800 bg-ink-900/60 p-4">
												<div className="flex flex-wrap items-center gap-2">
													<span className="font-mono text-sm font-medium">{p.name}</span>
													{p.version && <span className="font-mono text-[11px] text-ink-500">v{p.version}</span>}
													<Kinds kinds={p.kinds} />
													{p.filtered && <Badge>{t("filtered")}</Badge>}
													{updatable.has(p.source) && <Badge tone="moss">{t("update")}</Badge>}
													<span className="ml-auto flex items-center gap-1">
														{updatable.has(p.source) && (
															<Button disabled={busy} onClick={() => void update(p.source)}>
																{updating ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUpCircle className="size-4" />} {updating ? t("updating") : t("update")}
															</Button>
														)}
														<Button variant="danger" disabled={busy || p.scope !== "user"} onClick={() => remove(p)}>
															{removing ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />} {removing ? t("removing") : t("remove")}
														</Button>
													</span>
												</div>
												{p.description && <p className="mt-1.5 text-sm text-ink-400">{p.description}</p>}
												<p className="mt-1.5 truncate font-mono text-[11px] text-ink-600">
													{p.scope} · {p.source}
												</p>
												{!p.installed && <p className="mt-1 text-xs text-rose-400">{t("notInstalled")}</p>}
											</div>
										);
									})}
								</div>
							)}
						</>
					)}

					{tab === "discover" && (
						<>
							<form
								className="flex gap-2"
								onSubmit={(e) => {
									e.preventDefault();
									void runSearch(query, 0);
								}}
							>
								<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} />
								<Button type="submit" variant="primary" disabled={searching}>
									{searching && page === 0 ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />} {t("searchBtn")}
								</Button>
							</form>

							<form
								className="space-y-1.5"
								onSubmit={(e) => {
									e.preventDefault();
									const source = manual.trim();
									if (!source) return;
									void install(source, source).then((ok) => { if (ok) void setManual(""); });
								}}
							>
								<span className="text-xs text-ink-500">{t("manual")}</span>
								<div className="flex gap-2">
									<Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("manualPlaceholder")} className="font-mono text-xs" />
									<Button type="submit" variant="outline" disabled={busy || !manual.trim()}>
										<Download className="size-4" /> {t("install")}
									</Button>
								</div>
							</form>

							{searchError && (
								<Empty icon={<Package className="size-5" />} title={t("unavailable")}>
									<Button variant="outline" onClick={() => void runSearch(query, 0)}>
										{t("retry")}
									</Button>
								</Empty>
							)}
							{!searchError && !searching && results.length === 0 && <Empty icon={<Package className="size-5" />} title={t("emptyResults")} />}

							<div className="space-y-2">
								{results.map((r) => {
									const isInstalled = installedNames.has(r.name);
									const job = activeFor("install", r.source);
									return (
										<div key={r.name} className="animate-rise rounded-xl border border-ink-800 bg-ink-900/60 p-4">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-mono text-sm font-medium">{r.name}</span>
												<span className="font-mono text-[11px] text-ink-500">v{r.version}</span>
												{r.author && <span className="text-[11px] text-ink-500">· {r.author}</span>}
												<span className="ml-auto flex items-center gap-1">
													{(r.links.homepage ?? r.links.npm) && (
														<a
															href={r.links.homepage ?? r.links.npm}
															target="_blank"
															rel="noreferrer noopener"
															className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-800 hover:text-ink-100"
															aria-label="homepage"
														>
															<ExternalLink className="size-4" />
														</a>
													)}
													{isInstalled ? (
														<Badge tone="moss">{t("installedBadge")}</Badge>
													) : (
														<Button variant="outline" disabled={busy} onClick={() => void install(r.source, r.name)}>
															{job ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />} {job ? (job.status === "queued" ? t("queued") : t("installing")) : t("install")}
														</Button>
													)}
												</span>
											</div>
											{r.description && <p className="mt-1.5 line-clamp-3 text-sm text-ink-400">{r.description}</p>}
											{r.keywords.length > 0 && (
												<div className="mt-2 flex flex-wrap gap-1">
													{r.keywords.map((k) => (
														<Badge key={k}>{k}</Badge>
													))}
												</div>
											)}
										</div>
									);
								})}
							</div>

							{results.length > 0 && (
								<div className="flex items-center justify-between text-xs text-ink-500">
									<span>{t("total", { n: total })}</span>
									{results.length < total && (
										<Button variant="ghost" disabled={searching} onClick={() => void runSearch(query, page + 1)}>
											{searching ? <LoaderCircle className="size-4 animate-spin" /> : null} {t("loadMore")}
										</Button>
									)}
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
