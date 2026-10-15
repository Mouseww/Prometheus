import { ArrowUpCircle, Download, ExternalLink, LoaderCircle, Package, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PackageInfo, PackageListing, PackageSearchPage, PackageUpdateInfo } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Input, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "插件市场",
		subtitle: "安装 PI 扩展包：工具、技能、提示词模板与主题，与 PI TUI 共享",
		installedTab: "已安装",
		discoverTab: "发现",
		search: "搜索扩展包…",
		searchBtn: "搜索",
		manual: "或直接安装：npm 包名 / git 地址",
		manualPlaceholder: "npm:@scope/pkg@1.0.0 或 git:github.com/owner/repo",
		install: "安装",
		installing: "安装中…",
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
		installOk: "已安装 {name}，会话已重新加载",
		removeOk: "已卸载 {name}",
		updateOk: "更新完成，会话已重新加载",
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
	},
	en: {
		title: "Marketplace",
		subtitle: "Install PI packages: tools, skills, prompt templates and themes, shared with the PI TUI",
		installedTab: "Installed",
		discoverTab: "Discover",
		search: "Search packages…",
		searchBtn: "Search",
		manual: "Or install directly: npm name / git URL",
		manualPlaceholder: "npm:@scope/pkg@1.0.0 or git:github.com/owner/repo",
		install: "Install",
		installing: "Installing…",
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
		installOk: "Installed {name}; sessions reloaded",
		removeOk: "Removed {name}",
		updateOk: "Update complete; sessions reloaded",
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
	},
});

type Tab = "installed" | "discover";

const npmName = (source: string): string | undefined => {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4);
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
};

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

export function MarketView() {
	const t = useT(M);
	const [tab, setTab] = useState<Tab>("installed");
	const [installed, setInstalled] = useState<PackageInfo[]>([]);
	const [updates, setUpdates] = useState<PackageUpdateInfo[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PackageListing[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(0);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState(false);
	const [manual, setManual] = useState("");

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

	useEffect(() => {
		void loadInstalled();
	}, [loadInstalled]);
	useEffect(() => {
		if (tab === "discover" && results.length === 0 && !searching && !searchError) void runSearch(query, 0);
	}, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

	const installedNames = useMemo(() => new Set(installed.flatMap((p) => [npmName(p.source), p.name]).filter(Boolean)), [installed]);
	const updatable = useMemo(() => new Set(updates.map((u) => u.source)), [updates]);

	const act = async (key: string, task: () => Promise<boolean>) => {
		setBusy(key);
		try {
			await task();
		} finally {
			setBusy(null);
		}
	};

	const install = (source: string, label: string) =>
		act(`install:${source}`, async () => {
			const res = await pluginCall<PackageInfo | null>("packages", "install", { source });
			if (res === undefined) return false;
			toast(t("installOk", { name: label }));
			await loadInstalled();
			return true;
		});

	const remove = (p: PackageInfo) => {
		if (!window.confirm(t("confirmRemove", { name: p.name }))) return;
		void act(`remove:${p.source}`, async () => {
			const res = await pluginCall<null>("packages", "remove", { source: p.source });
			if (res === undefined) return false;
			toast(t("removeOk", { name: p.name }));
			setUpdates((u) => u.filter((x) => x.source !== p.source));
			await loadInstalled();
			return true;
		});
	};

	const update = (source?: string) =>
		act(`update:${source ?? "*"}`, async () => {
			const res = await pluginCall<null>("packages", "update", source ? { source } : {});
			if (res === undefined) return false;
			toast(t("updateOk"));
			setUpdates((u) => (source ? u.filter((x) => x.source !== source) : []));
			await loadInstalled();
			return true;
		});

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
								<Button variant="primary" disabled={busy !== null} onClick={() => void update()}>
									{busy === "update:*" ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUpCircle className="size-4" />} {busy === "update:*" ? t("updating") : t("updateAll")}
								</Button>
							)}
						</>
					) : undefined
				}
			/>
			<div className="flex gap-1 border-b hairline px-6 py-2">
				<button type="button" className={tabClass(tab === "installed")} onClick={() => setTab("installed")}>
					{t("installedTab")}
					{installed.length > 0 && <span className="ml-1.5 font-mono text-[11px] text-ink-500">{installed.length}</span>}
				</button>
				<button type="button" className={tabClass(tab === "discover")} onClick={() => setTab("discover")}>
					{t("discoverTab")}
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-6">
				<div className="mx-auto max-w-4xl space-y-5">
					<p className="rounded-lg border border-ember-500/20 bg-ember-500/5 px-3 py-2 text-xs text-ember-200">{t("trust")}</p>

					{tab === "installed" && (
						<>
							{installed.length === 0 ? (
								<Empty icon={<Package className="size-5" />} title={t("emptyInstalled")}>
									{t("emptyInstalledBody")}
								</Empty>
							) : (
								<div className="space-y-2">
									{installed.map((p) => (
										<div key={`${p.scope}:${p.source}`} className="animate-rise rounded-xl border border-ink-800 bg-ink-900/60 p-4">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-mono text-sm font-medium">{p.name}</span>
												{p.version && <span className="font-mono text-[11px] text-ink-500">v{p.version}</span>}
												<Kinds kinds={p.kinds} />
												{p.filtered && <Badge>{t("filtered")}</Badge>}
												{updatable.has(p.source) && <Badge tone="moss">{t("update")}</Badge>}
												<span className="ml-auto flex items-center gap-1">
													{updatable.has(p.source) && (
														<Button disabled={busy !== null} onClick={() => void update(p.source)}>
															{busy === `update:${p.source}` ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUpCircle className="size-4" />} {t("update")}
														</Button>
													)}
													<Button variant="danger" disabled={busy !== null || p.scope !== "user"} onClick={() => remove(p)}>
														{busy === `remove:${p.source}` ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{" "}
														{busy === `remove:${p.source}` ? t("removing") : t("remove")}
													</Button>
												</span>
											</div>
											{p.description && <p className="mt-1.5 text-sm text-ink-400">{p.description}</p>}
											<p className="mt-1.5 truncate font-mono text-[11px] text-ink-600">
												{p.scope} · {p.source}
											</p>
											{!p.installed && <p className="mt-1 text-xs text-rose-400">{t("notInstalled")}</p>}
										</div>
									))}
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
									if (source) void install(source, source).then(() => setManual(""));
								}}
							>
								<span className="text-xs text-ink-500">{t("manual")}</span>
								<div className="flex gap-2">
									<Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("manualPlaceholder")} className="font-mono text-xs" />
									<Button type="submit" variant="outline" disabled={busy !== null || !manual.trim()}>
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
									const key = `install:${r.source}`;
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
														<Button variant="outline" disabled={busy !== null} onClick={() => void install(r.source, r.name)}>
															{busy === key ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />} {busy === key ? t("installing") : t("install")}
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
