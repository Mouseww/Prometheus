import { Bug, Copy, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { copyToClipboard } from "../lib/clipboard.ts";
import { confirmDialog } from "../lib/dialogs.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, PageHeader } from "./ui.tsx";

interface LogEntry {
	id: number;
	at: number;
	level: "error" | "warn";
	message: string;
}

interface LogData {
	entries: LogEntry[];
	counts: { error: number; warn: number };
}

type Filter = "error" | "warn" | "all";

const M = defineMessages({
	zh: {
		title: "错误日志",
		subtitle: "记录服务端与插件输出的错误和警告(含未捕获异常),重启后保留最近 500 条",
		errors: "错误",
		warns: "警告",
		all: "全部",
		refresh: "刷新",
		clear: "清空",
		clearAsk: "清空全部日志?",
		copy: "复制",
		copyAll: "复制全部",
		copied: "已复制",
		empty: "没有日志",
		emptyBody: "运行正常时这里是空的。出现错误后点“刷新”查看。",
		level_error: "错误",
		level_warn: "警告",
	},
	en: {
		title: "Error log",
		subtitle: "Errors and warnings printed by the server and plugins (including uncaught exceptions). The latest 500 survive a restart.",
		errors: "Errors",
		warns: "Warnings",
		all: "All",
		refresh: "Refresh",
		clear: "Clear",
		clearAsk: "Clear all log entries?",
		copy: "Copy",
		copyAll: "Copy all",
		copied: "Copied",
		empty: "No log entries",
		emptyBody: "This stays empty while everything works. Press Refresh after something goes wrong.",
		level_error: "Error",
		level_warn: "Warning",
	},
});

const fmtTime = (at: number) => new Date(at).toLocaleString(undefined, { hour12: false });

export function LogsView() {
	const t = useT(M);
	const [filter, setFilter] = useState<Filter>("error");
	const [data, setData] = useState<LogData | null>(null);

	const load = useCallback(async () => {
		const res = await pluginCall<LogData>("logs", "list", { level: filter === "all" ? undefined : filter });
		if (res) setData(res);
	}, [filter]);

	useEffect(() => {
		void load();
	}, [load]);

	const copy = async (text: string) => {
		await copyToClipboard(text);
		toast(t("copied"));
	};

	const clear = async () => {
		if (!(await confirmDialog(t("clearAsk")))) return;
		const res = await pluginCall<LogData>("logs", "clear");
		if (res) setData(res);
	};

	const entries = data?.entries ?? [];
	const tabs: { id: Filter; label: string; n?: number }[] = [
		{ id: "error", label: t("errors"), n: data?.counts.error },
		{ id: "warn", label: t("warns"), n: data?.counts.warn },
		{ id: "all", label: t("all") },
	];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<>
						<Button variant="outline" onClick={() => void load()}>
							<RefreshCw className="size-3.5" /> {t("refresh")}
						</Button>
						<Button variant="outline" disabled={entries.length === 0} onClick={() => void copy(entries.map((e) => `[${fmtTime(e.at)}] ${e.level.toUpperCase()} ${e.message}`).join("\n\n"))}>
							<Copy className="size-3.5" /> {t("copyAll")}
						</Button>
						<Button variant="danger" disabled={!data || data.counts.error + data.counts.warn === 0} onClick={() => void clear()}>
							<Trash2 className="size-3.5" /> {t("clear")}
						</Button>
					</>
				}
			/>
			<div className="flex gap-1 border-b hairline px-4 py-2 @3xl:px-8">
				{tabs.map((x) => (
					<button
						key={x.id}
						type="button"
						onClick={() => setFilter(x.id)}
						className={`rounded-md px-3 py-1.5 text-xs transition-colors ${filter === x.id ? "bg-ink-800 text-ink-100" : "text-ink-400 hover:text-ink-200"}`}
					>
						{x.label}
						{x.n ? ` ${x.n}` : ""}
					</button>
				))}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 @3xl:px-8">
				{data && entries.length === 0 ? (
					<Empty icon={<Bug className="size-5" />} title={t("empty")}>
						{t("emptyBody")}
					</Empty>
				) : (
					<ul className="space-y-2">
						{entries.map((e) => (
							<li key={e.id} className="rounded-lg border border-ink-700 bg-ink-900/60 p-3">
								<div className="mb-1.5 flex items-center gap-2">
									<Badge tone={e.level === "error" ? "rose" : "ember"}>{t(e.level === "error" ? "level_error" : "level_warn")}</Badge>
									<span className="text-xs text-ink-500">{fmtTime(e.at)}</span>
									<button type="button" title={t("copy")} onClick={() => void copy(e.message)} className="ml-auto text-ink-500 hover:text-ink-200">
										<Copy className="size-3.5" />
									</button>
								</div>
								<pre className="max-h-64 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-ink-200">{e.message}</pre>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
