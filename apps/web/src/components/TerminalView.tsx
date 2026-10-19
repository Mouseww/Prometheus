import { Brush, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { terminalIds, useStore, type WorkbenchTab } from "../lib/store.ts";

const M = defineMessages({
	zh: {
		prompt: "输入命令，回车执行（Ctrl+C 中断）",
		interrupt: "中断当前命令",
		clear: "清屏",
		restart: "重新打开终端",
		ended: "终端已关闭或服务已重启。",
	},
	en: {
		prompt: "Type a command, Enter to run (Ctrl+C interrupts)",
		interrupt: "Interrupt the running command",
		clear: "Clear",
		restart: "Reopen terminal",
		ended: "The terminal was closed or the service restarted.",
	},
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const clean = (t: string) => t.replace(ANSI, "").replace(/\r/g, "");
const KEEP_CHARS = 300_000;

interface ReadResult {
	data: string;
	next: number;
	alive: boolean;
}

/** Polling must stay quiet: a toast every few hundred milliseconds would bury the screen. */
const quiet = <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
	const client = useStore.getState().client;
	if (!client) return Promise.reject(new Error("offline"));
	return client.rpc("plugin.call", { plugin: "terminal", method, params }) as Promise<T>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function TerminalView({ tab }: { tab: Extract<WorkbenchTab, { kind: "terminal" }> }) {
	const t = useT(M);
	const [text, setText] = useState("");
	const [alive, setAlive] = useState(true);
	const [lost, setLost] = useState(false);
	const [epoch, setEpoch] = useState(0);
	const [line, setLine] = useState("");
	const history = useRef<string[]>([]);
	const cursor = useRef(-1);
	const sid = useRef<string | undefined>(terminalIds.get(tab.id));
	const input = useRef<HTMLInputElement>(null);
	const screen = useRef<HTMLPreElement>(null);
	const stick = useRef(true);

	// The shell lives on the server, so switching tabs only stops polling; coming back replays its output.
	// biome-ignore lint/correctness/useExhaustiveDependencies: epoch restarts the loop on purpose
	useEffect(() => {
		let dead = false;
		let since = 0;
		setLost(false);
		setText("");
		void (async () => {
			try {
				if (!sid.current) {
					const r = await quiet<{ id: string }>("open", { cwd: tab.cwd });
					sid.current = r.id;
					terminalIds.set(tab.id, r.id);
				}
				while (!dead) {
					const r = await quiet<ReadResult>("read", { id: sid.current, since });
					since = r.next;
					if (r.data) setText((old) => (old + clean(r.data)).slice(-KEEP_CHARS));
					setAlive(r.alive);
					await new Promise((res) => setTimeout(res, r.data ? 120 : 400));
				}
			} catch (e) {
				if (dead) return;
				sid.current = undefined;
				terminalIds.delete(tab.id);
				setText((old) => `${old}\n[${message(e)}]\n`);
				setLost(true);
			}
		})();
		return () => {
			dead = true;
		};
	}, [tab.id, tab.cwd, epoch]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the output grows
	useEffect(() => {
		const el = screen.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [text]);

	const send = (value: string) => {
		if (!sid.current) return;
		void quiet("run", { id: sid.current, line: value }).catch((e) => setText((old) => `${old}\n[${message(e)}]\n`));
	};
	const interrupt = () => {
		if (sid.current) void quiet("interrupt", { id: sid.current }).catch(() => undefined);
	};
	const reopen = () => {
		if (sid.current) void quiet("close", { id: sid.current }).catch(() => undefined);
		sid.current = undefined;
		terminalIds.delete(tab.id);
		setAlive(true);
		setEpoch((n) => n + 1);
	};

	return (
		<div className="flex h-full flex-col bg-ink-950" onClick={() => !window.getSelection()?.toString() && input.current?.focus()}>
			<div className="flex shrink-0 items-center gap-2 border-b hairline px-3 py-1.5 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono text-ink-400" title={tab.cwd}>
					{tab.cwd}
				</span>
				<button type="button" onClick={interrupt} disabled={!alive || lost} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-rose-400 disabled:opacity-40" title={t("interrupt")}>
					<Square className="size-3.5" />
				</button>
				<button type="button" onClick={() => setText("")} className="grid size-6 place-items-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100" title={t("clear")}>
					<Brush className="size-3.5" />
				</button>
			</div>
			<pre
				ref={screen}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				}}
				className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[12px] leading-5 text-ink-200"
			>
				{text}
			</pre>
			{lost || !alive ? (
				<div className="flex shrink-0 items-center gap-2 border-t hairline px-3 py-2 text-xs text-ink-400">
					<span className="flex-1">{t("ended")}</span>
					<button type="button" onClick={reopen} className="rounded-md bg-ink-800 px-2.5 py-1 text-ink-200 hover:bg-ink-700">
						{t("restart")}
					</button>
				</div>
			) : (
				<form
					className="flex shrink-0 items-center gap-2 border-t hairline px-3 py-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (!line.trim()) return;
						history.current.push(line);
						cursor.current = -1;
						send(line);
						setLine("");
						stick.current = true;
					}}
				>
					<span className="font-mono text-xs text-ember-400">&gt;</span>
					<input
						ref={input}
						// biome-ignore lint/a11y/noAutofocus: opening the terminal means typing in it
						autoFocus
						value={line}
						onChange={(e) => setLine(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "c" && e.ctrlKey && !window.getSelection()?.toString()) {
								e.preventDefault();
								interrupt();
							} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
								const h = history.current;
								if (!h.length) return;
								e.preventDefault();
								if (e.key === "ArrowUp") cursor.current = cursor.current < 0 ? h.length - 1 : Math.max(0, cursor.current - 1);
								else if (cursor.current >= 0) cursor.current = cursor.current + 1 >= h.length ? -1 : cursor.current + 1;
								setLine(cursor.current < 0 ? "" : (h[cursor.current] ?? ""));
							}
						}}
						placeholder={t("prompt")}
						spellCheck={false}
						autoComplete="off"
						className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-100 outline-none placeholder:text-ink-600"
					/>
				</form>
			)}
		</div>
	);
}
