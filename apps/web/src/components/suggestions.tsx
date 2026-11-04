import clsx from "clsx";
import { File as FileIcon, Folder as FolderIcon } from "lucide-react";
import type { CommandInfo } from "@prometheus/protocol";

/**
 * The "/" and "@" suggestion lists, shared by the chat composer and the assistant home page. They were private to
 * Composer until the home page's box needed the same menus; drawing them from one place keeps the two in step (the
 * row rhythm, the source tag, the folder/file icons) instead of letting a second copy drift.
 */

/** Commands offered by the "/" menu: extensions, prompt templates, skills and built-ins. */
export function SlashCommands({ items, cursor, onPick }: { items: CommandInfo[]; cursor: number; onPick: (c: CommandInfo) => void }) {
	return (
		<>
			{items.map((c, i) => (
				<button
					key={`${c.source}:${c.name}`}
					type="button"
					onMouseDown={(e) => {
						e.preventDefault();
						onPick(c);
					}}
					className={clsx("flex w-full items-baseline gap-3 px-3.5 py-2 text-left", i === cursor ? "bg-ink-800" : "hover:bg-ink-850")}
				>
					<span className="font-mono text-sm text-ember-300">/{c.name}</span>
					<span className="min-w-0 flex-1 truncate text-xs text-ink-400">{c.description}</span>
					<span className="font-mono text-[10px] text-ink-600 uppercase">{c.source}</span>
				</button>
			))}
		</>
	);
}

/** Workspace paths offered by the "@" menu, split into name and folder so long trees stay readable. */
export function Mentions({ items, cursor, onPick, onHover }: { items: { path: string; dir: boolean }[]; cursor: number; onPick: (item: { path: string; dir: boolean }) => void; onHover: (index: number) => void }) {
	return (
		<>
			{items.map((it, i) => {
				const slash = it.path.lastIndexOf("/");
				const name = it.path.slice(slash + 1);
				const dir = slash >= 0 ? it.path.slice(0, slash) : "";
				const Icon = it.dir ? FolderIcon : FileIcon;
				return (
					<button
						key={it.path}
						type="button"
						onMouseDown={(e) => {
							e.preventDefault();
							onPick(it);
						}}
						onMouseEnter={() => onHover(i)}
						className={clsx("flex w-full items-baseline gap-2 px-3.5 py-2 text-left", i === cursor ? "bg-ink-800" : "hover:bg-ink-850")}
					>
						<Icon className="size-3.5 shrink-0 self-center text-ink-400" />
						<span className="font-mono text-sm text-ember-300">
							{name}
							{it.dir ? "/" : ""}
						</span>
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-500">{dir}</span>
					</button>
				);
			})}
		</>
	);
}

/** The floating panel both menus sit in. */
export function SuggestionPanel({ children }: { children: React.ReactNode }) {
	return <div className="absolute right-3 bottom-full left-3 z-30 mb-2 overflow-hidden rounded-xl border border-ink-700 bg-ink-900/95 shadow-2xl shadow-black/40 backdrop-blur md:right-5 md:left-5">{children}</div>;
}
