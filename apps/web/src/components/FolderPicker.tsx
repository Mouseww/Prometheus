import { ArrowUp, ChevronRight, Clock, CornerLeftUp, Folder, HardDrive, Home, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DirListing } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { useStore } from "../lib/store.ts";
import { Button, Input } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "打开项目目录",
		hint: "同一目录下的对话会归入同一个工作区",
		up: "上一级",
		home: "主目录",
		choose: "使用此目录",
		cancel: "取消",
		empty: "没有子目录",
		go: "前往",
		places: "位置",
		recent: "最近的工作区",
		path: "目录地址",
		loadFailed: "无法读取该目录",
	},
	en: {
		title: "Open a project folder",
		hint: "Chats in the same folder are grouped into one workspace",
		up: "Up",
		home: "Home",
		choose: "Use this folder",
		cancel: "Cancel",
		empty: "No subfolders",
		go: "Go",
		places: "Places",
		recent: "Recent workspaces",
		path: "Folder path",
		loadFailed: "Cannot read that folder",
	},
});

/**
 * Server-side directory browser, rendered through a portal so the dialog floats over the whole
 * window instead of being clipped to the sidebar. Works the same for local and remote servers.
 * It always opens at the server's home directory; existing workspaces are one click away.
 */
export function FolderPicker({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
	const t = useT(M);
	const recent = useStore((s) => s.workspaces);
	const [listing, setListing] = useState<DirListing | null>(null);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const req = useRef(0);

	/** Resolves to false when the server rejected the path, so callers can fall back to home. */
	const load = async (path?: string): Promise<boolean> => {
		const client = useStore.getState().client;
		if (!client) return false;
		const id = ++req.current;
		setLoading(true);
		setError(null);
		try {
			const next = await client.rpc("fs.dirs", path ? { path } : {});
			if (id !== req.current) return false;
			setListing(next);
			setInput(next.path);
			return true;
		} catch (err) {
			if (id !== req.current) return false;
			// Report inline: a toast would cover the dialog the user is looking at.
			setError(err instanceof Error ? err.message : t("loadFailed"));
			return false;
		} finally {
			if (id === req.current) setLoading(false);
		}
	};

	// Opening at home is the least surprising default; a failure still leaves the dialog usable.
	useEffect(() => {
		void load(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const go = (path?: string) => void load(path);

	return createPortal(
		<div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="flex h-[min(620px,88vh)] w-[min(880px,94vw)] animate-rise flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/50">
				<div className="flex items-start justify-between gap-3 px-6 pt-4 pb-3">
					<div>
						<h2 className="font-display text-lg font-semibold">{t("title")}</h2>
						<p className="text-xs text-ink-500">{t("hint")}</p>
					</div>
					<button type="button" onClick={onClose} className="rounded-md p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100" aria-label={t("cancel")}>
						<X className="size-4" />
					</button>
				</div>
				<form
					className="flex gap-2 px-6 pb-3"
					onSubmit={(e) => {
						e.preventDefault();
						go(input);
					}}
				>
					<Input
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder={listing?.home ?? t("path")}
						aria-label={t("path")}
						className="font-mono text-xs"
						spellCheck={false}
					/>
					<Button type="submit" variant="outline" className="shrink-0 whitespace-nowrap">
						{t("go")}
					</Button>
				</form>
				<div className="flex flex-wrap items-center gap-1 border-y hairline px-5 py-2">
					<Button variant="ghost" className="px-2 py-1 text-xs" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)}>
						<CornerLeftUp className="size-3.5" /> {t("up")}
					</Button>
					<Button variant="ghost" className="px-2 py-1 text-xs" disabled={!listing?.home} onClick={() => go(listing?.home)}>
						<Home className="size-3.5" /> {t("home")}
					</Button>
					{loading && <LoaderCircle className="ml-auto size-4 animate-spin text-ink-500" />}
				</div>

				<div className="grid min-h-0 flex-1 grid-cols-[200px_1fr]">
					<aside className="min-h-0 overflow-y-auto border-r hairline px-2 py-2">
						<p className="px-2 pt-1 pb-1.5 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("places")}</p>
						<button
							type="button"
							onClick={() => go(listing?.home)}
							className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink-200 hover:bg-ink-800"
						>
							<Home className="size-4 shrink-0 text-ember-400" />
							<span className="min-w-0 flex-1 truncate">{t("home")}</span>
						</button>
						{listing?.roots.map((r) => (
							<button key={r} type="button" onClick={() => go(r)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink-200 hover:bg-ink-800">
								<HardDrive className="size-4 shrink-0 text-ink-400" />
								<span className="min-w-0 flex-1 truncate font-mono text-xs">{r.replace(/\\$/, "")}</span>
							</button>
						))}
						{recent.length > 0 && (
							<>
								<p className="px-2 pt-3 pb-1.5 font-mono text-[10.5px] tracking-widest text-ink-500 uppercase">{t("recent")}</p>
								{recent.map((w) => (
									<button
										key={w.id}
										type="button"
										onClick={() => go(w.path)}
										title={w.path}
										className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink-300 hover:bg-ink-800"
									>
										<Clock className="size-3.5 shrink-0 text-ink-500" />
										<span className="min-w-0 flex-1 truncate">{w.name}</span>
									</button>
								))}
							</>
						)}
					</aside>

					<div className="min-h-0 overflow-y-auto p-2">
						{error && (
							<p className="flex items-center gap-2 px-3 py-2 text-xs text-rose-400">
								<TriangleAlert className="size-3.5 shrink-0" /> {error}
							</p>
						)}
						{listing?.dirs.length === 0 && <p className="py-10 text-center text-sm text-ink-500">{t("empty")}</p>}
						<div className="grid grid-cols-2 gap-0.5">
							{listing?.dirs.map((d) => (
								<button
									key={d.path}
									type="button"
									onClick={() => go(d.path)}
									onDoubleClick={() => onPick(d.path)}
									className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-ink-200 hover:bg-ink-800"
								>
									<Folder className="size-4 shrink-0 text-ember-400" />
									<span className="min-w-0 flex-1 truncate">{d.name}</span>
									<ChevronRight className="size-3.5 shrink-0 text-ink-600 group-hover:text-ink-400" />
								</button>
							))}
						</div>
					</div>
				</div>

				<div className="flex items-center gap-2 border-t hairline px-6 py-3">
					<span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-500" title={listing?.path}>
						{listing?.path}
					</span>
					<Button variant="outline" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button variant="primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
						<ArrowUp className="size-4 rotate-45" /> {t("choose")}
					</Button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
