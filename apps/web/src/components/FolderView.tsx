import clsx from "clsx";
import { Collapse } from "./ui.tsx";
import { ChevronRight, File, Folder, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FolderListing } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { openFile, pluginCall, useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: { refresh: "刷新", empty: "空文件夹", truncated: "条目过多，只显示前 2000 项", failed: "无法读取文件夹" },
	en: { refresh: "Refresh", empty: "Empty folder", truncated: "Too many entries: showing the first 2000", failed: "Cannot read folder" },
});

type Listings = Record<string, FolderListing | "error">;

/** Lazy file tree rooted at the session's folder. Clicking a file opens it in the viewer. */
export function FolderView({ cwd }: { cwd: string }) {
	const t = useT(M);
	const [listings, setListings] = useState<Listings>({});
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState<Set<string>>(new Set());
	const streaming = useStore((s) => s.session?.isStreaming ?? false);

	const load = useCallback(
		async (path: string) => {
			setLoading((l) => new Set(l).add(path));
			const res = await pluginCall<FolderListing>("folder", "list", { path, cwd }).catch(() => undefined);
			setListings((l) => ({ ...l, [path]: res ?? "error" }));
			setLoading((l) => {
				const n = new Set(l);
				n.delete(path);
				return n;
			});
		},
		[cwd],
	);

	const reload = useCallback(() => {
		// Refresh the root and every expanded folder.
		for (const p of ["", ...open]) void load(p);
	}, [load, open]);

	useEffect(() => {
		void load("");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [load]);

	// The agent may have created or removed files during its turn.
	useEffect(() => {
		if (!streaming) reload();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [streaming]);

	const toggle = (path: string) => {
		const next = new Set(open);
		if (next.has(path)) next.delete(path);
		else {
			next.add(path);
			if (!listings[path]) void load(path);
		}
		setOpen(next);
	};

	const render = (path: string, depth: number): React.ReactNode => {
		const l = listings[path];
		if (!l) return loading.has(path) ? <Row depth={depth}><LoaderCircle className="size-3.5 animate-spin text-ink-500" /></Row> : null;
		if (l === "error") return <p className="px-3 py-1 text-xs text-ink-500" style={{ paddingLeft: 12 + depth * 14 }}>{t("failed")}</p>;
		if (!l.entries.length) return <p className="px-3 py-1 text-xs text-ink-500" style={{ paddingLeft: 12 + depth * 14 }}>{t("empty")}</p>;
		return (
			<>
				{l.entries.map((e) =>
					e.dir ? (
						<div key={e.path}>
							<button type="button" onClick={() => toggle(e.path)} className="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-[13px] text-ink-200 hover:bg-ink-800" style={{ paddingLeft: 8 + depth * 14 }}>
								<ChevronRight className={clsx("size-3 shrink-0 text-ink-500 transition-transform", open.has(e.path) && "rotate-90")} />
								{open.has(e.path) ? <FolderOpen className="size-3.5 shrink-0 text-ember-400" /> : <Folder className="size-3.5 shrink-0 text-ember-400" />}
								<span className="truncate">{e.name}</span>
							</button>
							<Collapse open={open.has(e.path)}>{render(e.path, depth + 1)}</Collapse>
						</div>
					) : (
						<button key={e.path} type="button" onClick={() => openFile(e.path, cwd)} className="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-[13px] text-ink-300 hover:bg-ink-800 hover:text-ink-100" style={{ paddingLeft: 8 + depth * 14 + 16 }} title={e.path}>
							<File className="size-3.5 shrink-0 text-ink-500" />
							<span className="truncate">{e.name}</span>
						</button>
					),
				)}
				{l.truncated && <p className="px-3 py-1 text-[11px] text-ink-500">{t("truncated")}</p>}
			</>
		);
	};

	const root = listings[""];
	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b hairline px-3 py-1.5 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono text-ink-400" title={typeof root === "object" ? root.path : cwd}>
					{typeof root === "object" ? root.path : cwd}
				</span>
				<button type="button" onClick={reload} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={t("refresh")}>
					<RefreshCw className={clsx("size-3.5", loading.size > 0 && "animate-spin")} />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto py-1">{render("", 0)}</div>
		</div>
	);
}

function Row({ depth, children }: { depth: number; children: React.ReactNode }) {
	return (
		<div className="px-3 py-1" style={{ paddingLeft: 12 + depth * 14 }}>
			{children}
		</div>
	);
}
