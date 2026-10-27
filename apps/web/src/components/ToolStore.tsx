import clsx from "clsx";
import { Check, Download, LoaderCircle, RotateCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { APT_CATALOG, APT_CATEGORIES, type AptCategory, type AptEntry, idsFor, matchesApt, storePlatform } from "../lib/aptCatalog.ts";
import { isAndroid } from "../lib/backend.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { APT_JOB, type AptHit, cancelRuntime, installApt, searchApt, uninstallApt, useRuntimes } from "../lib/runtimes.ts";
import { JobView } from "./RuntimesSettings.tsx";
import { Button } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "工具商店",
		subtitle: "一键安装语言、编译器和命令行工具，装好后在终端和 Agent 里直接使用。Android 装进 PRoot Ubuntu，Windows 用 winget，macOS 用 Homebrew，Linux 用 apt。",
		noManager: "这台电脑上没有可用的包管理器：Windows 需要 winget，macOS 需要先安装 Homebrew（brew.sh），Linux 需要 apt 和 pkexec（Debian / Ubuntu 系）。",
		restartHint: "装好后重启 Prometheus，新命令才会出现在 Agent 的 PATH 里。",
		search: "搜索工具，如 java、ffmpeg、ssh",
		all: "全部",
		noMatch: "商店里没有匹配的工具",
		searchIndex: "在 Ubuntu 软件源中搜索“{q}”",
		searching: "搜索中（第一次需要下载软件源索引）…",
		indexHits: "软件源搜索结果（{n}）",
		indexNone: "软件源里也没有找到“{q}”",
		baseNote: "还没有 Linux 基础系统（约 30 MB）。安装任意工具时会自动准备。",
		busy: "有安装任务在进行",
		confirmRemove: "卸载 {name}？",
		install: "安装",
		uninstall: "卸载",
		cancel: "取消",
		retry: "重试",
		installed: "已安装",
		size: "约 {n} MB",
	},
	en: {
		title: "Tool store",
		subtitle: "One-tap install of languages, compilers and command-line tools for the terminal and the agent. Android installs into PRoot Ubuntu, Windows uses winget, macOS uses Homebrew, Linux uses apt.",
		noManager: "No usable package manager here: Windows needs winget, macOS needs Homebrew (brew.sh), Linux needs apt and pkexec (Debian / Ubuntu family).",
		restartHint: "Restart Prometheus after installing so new commands show up on the agent's PATH.",
		search: "Search tools, e.g. java, ffmpeg, ssh",
		all: "All",
		noMatch: "No tool in the store matches",
		searchIndex: "Search the Ubuntu package index for \"{q}\"",
		searching: "Searching (the first time downloads the package index)…",
		indexHits: "Package index results ({n})",
		indexNone: "\"{q}\" is not in the package index either",
		baseNote: "The Linux base system (about 30 MB) is not installed yet. It is set up automatically with your first tool.",
		busy: "An install is in progress",
		confirmRemove: "Uninstall {name}?",
		install: "Install",
		uninstall: "Uninstall",
		cancel: "Cancel",
		retry: "Retry",
		installed: "Installed",
		size: "about {n} MB",
	},
});

function StoreRow({ id, name, desc, packages, sizeMb, installed, busy }: { id: string; name: string; desc: string; packages: string[]; sizeMb?: number; installed: boolean; busy: boolean }) {
	const t = useT(M);
	const jobId = `${APT_JOB}${id}`;
	const job = useRuntimes((s) => s.jobs[jobId]);
	const running = job != null && !job.finished;
	const failed = job?.finished && !job.ok;
	const remove = async () => {
		if (!window.confirm(t("confirmRemove", { name }))) return;
		await uninstallApt(id, name, packages);
	};
	return (
		<div className="space-y-2 rounded-xl border border-ink-800 bg-ink-900/40 p-3.5">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<h4 className="text-sm font-medium break-all text-ink-100">{name}</h4>
						{installed && (
							<span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-400">
								<Check className="size-3" />
								{t("installed")}
							</span>
						)}
					</div>
					<p className="mt-0.5 text-xs leading-relaxed text-ink-400">{desc}</p>
					<p className="mt-0.5 truncate font-mono text-[11px] text-ink-600">
						{packages.join(" ")}
						{sizeMb ? ` · ${t("size", { n: sizeMb })}` : ""}
					</p>
				</div>
				<div className="shrink-0">
					{running ? (
						<Button variant="outline" onClick={() => void cancelRuntime(jobId)}>
							<X className="size-4" />
							{t("cancel")}
						</Button>
					) : installed ? (
						<Button variant="danger" disabled={busy} onClick={() => void remove()}>
							<Trash2 className="size-4" />
							{t("uninstall")}
						</Button>
					) : (
						<Button variant="primary" disabled={busy} title={busy ? t("busy") : undefined} onClick={() => void installApt(id, name, packages)}>
							{failed ? <RotateCw className="size-4" /> : <Download className="size-4" />}
							{failed ? t("retry") : t("install")}
						</Button>
					)}
				</div>
			</div>
			{job && (running || job.finished) && <JobView job={job} />}
		</div>
	);
}

/** Android: an app-store style list of what the PRoot Ubuntu can install, with search and a fallback to the whole package index. */
export function ToolStore() {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const apt = useRuntimes((s) => s.apt);
	const jobs = useRuntimes((s) => s.jobs);
	const items = useRuntimes((s) => s.items);
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<AptCategory | "all">("all");
	const [hits, setHits] = useState<AptHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);

	const platform = storePlatform();
	const android = isAndroid();
	const installed = useMemo(() => new Set(apt.installed.map((p) => p.toLowerCase())), [apt.installed]);
	const busy = Object.values(jobs).some((j) => !j.finished) || items.some((i) => i.installing);
	const shown = useMemo(() => APT_CATALOG.filter((e) => idsFor(e, platform) && (category === "all" || e.category === category) && matchesApt(e, query)), [category, query, platform]);
	const desc = (e: AptEntry) => (lang === "zh" ? e.zh : e.en);
	const known = useMemo(() => new Set(APT_CATALOG.flatMap((e) => e.packages)), []);

	// A new query invalidates the previous index results.
	useEffect(() => {
		setHits(null);
		setSearchError(null);
	}, [query]);

	const runSearch = async () => {
		setSearching(true);
		setSearchError(null);
		try {
			setHits(await searchApt(query.trim()));
		} catch (err) {
			setSearchError(String(err));
		} finally {
			setSearching(false);
		}
	};

	const q = query.trim();
	const categories = [{ id: "all" as const, zh: t("all"), en: t("all") }, ...APT_CATEGORIES];
	return (
		<section className="space-y-3">
			<div>
				<h2 className="text-base font-medium text-ink-100">{t("title")}</h2>
				<p className="mt-1 text-xs leading-relaxed text-ink-400">{t("subtitle")}</p>
				{android && apt.loaded && !apt.rootfs && <p className="mt-1 text-xs leading-relaxed text-amber-300">{t("baseNote")}</p>}
			</div>
			{apt.loaded && !android && !apt.manager && <p className="text-xs leading-relaxed text-amber-300">{t("noManager")}</p>}
			{!android && apt.manager && <p className="text-xs leading-relaxed text-ink-500">{t("restartHint")}</p>}
			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" />
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("search")}
					className="w-full rounded-lg border border-ink-700 bg-ink-950 py-2 pr-9 pl-9 text-sm text-ink-100 outline-none focus:border-ember-400"
				/>
				{query && (
					<button type="button" aria-label="clear" onClick={() => setQuery("")} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-500 hover:text-ink-200">
						<X className="size-4" />
					</button>
				)}
			</div>
			<div className="flex gap-1.5 overflow-x-auto pb-1">
				{categories.map((c) => (
					<button
						key={c.id}
						type="button"
						onClick={() => setCategory(c.id)}
						className={clsx("shrink-0 rounded-full border px-3 py-1 text-xs", category === c.id ? "border-ember-400 bg-ember-400/10 text-ember-300" : "border-ink-700 text-ink-400 hover:text-ink-200")}
					>
						{lang === "zh" ? c.zh : c.en}
					</button>
				))}
			</div>
			<div className="space-y-2">
				{shown.map((e) => {
					const ids = idsFor(e, platform) ?? e.packages;
					return <StoreRow key={e.id} id={e.id} name={e.name} desc={desc(e)} packages={ids} sizeMb={e.sizeMb} installed={ids.every((p) => installed.has(p.toLowerCase()))} busy={busy || (!android && !apt.manager)} />;
				})}
				{shown.length === 0 && <p className="py-2 text-sm text-ink-500">{t("noMatch")}</p>}
			</div>
			{android && q && /^[A-Za-z0-9+._-]+$/.test(q) && (
				<div className="space-y-2">
					{hits == null && (
						<Button variant="outline" disabled={searching} onClick={() => void runSearch()}>
							{searching ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
							{searching ? t("searching") : t("searchIndex", { q })}
						</Button>
					)}
					{searchError && <p className="text-xs break-words text-rose-400">{searchError}</p>}
					{hits && (
						<>
							<h3 className="text-xs font-medium text-ink-400">{hits.length ? t("indexHits", { n: hits.length }) : t("indexNone", { q })}</h3>
							{hits
								.filter((h) => !known.has(h.name))
								.map((h) => (
									<StoreRow key={h.name} id={`pkg-${h.name}`} name={h.name} desc={h.description} packages={[h.name]} installed={installed.has(h.name)} busy={busy} />
								))}
						</>
					)}
				</div>
			)}
		</section>
	);
}
