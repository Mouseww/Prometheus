import { ArrowUp, ChevronRight, CornerLeftUp, Folder, HardDrive, Home, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DirListing } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call } from "../lib/store.ts";
import { Button, Input } from "./ui.tsx";

const M = defineMessages({
	zh: { title: "选择项目目录", hint: "同一目录下的对话会归入同一个工作区", up: "上一级", home: "主目录", choose: "使用此目录", cancel: "取消", empty: "没有子目录", go: "前往" },
	en: { title: "Choose a project folder", hint: "Chats in the same folder are grouped into one workspace", up: "Up", home: "Home", choose: "Use this folder", cancel: "Cancel", empty: "No subfolders", go: "Go" },
});

/** Server-side directory browser: works the same for the local server and remote ones. */
export function FolderPicker({ initial, onPick, onClose }: { initial?: string; onPick: (path: string) => void; onClose: () => void }) {
	const t = useT(M);
	const [listing, setListing] = useState<DirListing | null>(null);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);

	const load = async (path?: string) => {
		setLoading(true);
		const next = await call((c) => c.rpc("fs.dirs", { path }));
		setLoading(false);
		if (next) {
			setListing(next);
			setInput(next.path);
		}
	};

	useEffect(() => {
		void load(initial);
	}, [initial]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="flex h-[min(560px,90vh)] w-full max-w-xl animate-rise flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl shadow-black/50">
				<div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
					<div>
						<h2 className="font-display text-lg font-semibold">{t("title")}</h2>
						<p className="text-xs text-ink-500">{t("hint")}</p>
					</div>
					<button type="button" onClick={onClose} className="rounded-md p-1 text-ink-500 hover:bg-ink-800 hover:text-ink-100" aria-label={t("cancel")}>
						<X className="size-4" />
					</button>
				</div>
				<form
					className="flex gap-2 px-5 pb-3"
					onSubmit={(e) => {
						e.preventDefault();
						void load(input);
					}}
				>
					<Input value={input} onChange={(e) => setInput(e.target.value)} className="font-mono text-xs" spellCheck={false} />
					<Button type="submit" variant="outline">
						{t("go")}
					</Button>
				</form>
				<div className="flex flex-wrap items-center gap-1 border-y hairline px-4 py-2">
					<Button variant="ghost" className="px-2 py-1 text-xs" disabled={!listing?.parent} onClick={() => listing?.parent && void load(listing.parent)}>
						<CornerLeftUp className="size-3.5" /> {t("up")}
					</Button>
					<Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => void load(listing?.home)}>
						<Home className="size-3.5" /> {t("home")}
					</Button>
					{listing && listing.roots.length > 1 && <span className="mx-1 h-4 w-px bg-ink-700" />}
					{listing &&
						listing.roots.length > 1 &&
						listing.roots.map((r) => (
							<Button key={r} variant="ghost" className="px-2 py-1 font-mono text-xs" onClick={() => void load(r)}>
								<HardDrive className="size-3.5" /> {r.replace(/\\$/, "")}
							</Button>
						))}
					{loading && <LoaderCircle className="ml-auto size-4 animate-spin text-ink-500" />}
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-2">
					{listing?.dirs.length === 0 && <p className="py-10 text-center text-sm text-ink-500">{t("empty")}</p>}
					{listing?.dirs.map((d) => (
						<button
							key={d.path}
							type="button"
							onClick={() => void load(d.path)}
							onDoubleClick={() => onPick(d.path)}
							className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-ink-200 hover:bg-ink-800"
						>
							<Folder className="size-4 shrink-0 text-ember-400" />
							<span className="min-w-0 flex-1 truncate">{d.name}</span>
							<ChevronRight className="size-3.5 text-ink-600 group-hover:text-ink-400" />
						</button>
					))}
				</div>
				<div className="flex items-center gap-2 border-t hairline px-5 py-3">
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
		</div>
	);
}
