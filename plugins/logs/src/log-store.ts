import { format } from "node:util";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "error" | "warn";

export interface LogEntry {
	id: number;
	at: number;
	level: LogLevel;
	message: string;
}

export const MAX_ENTRIES = 500;
/** One entry never grows past this, so a log loop cannot fill the disk. */
const MAX_MESSAGE = 8000;

/** Masks credentials that routinely appear in error text (API keys, bearer tokens, key=value secrets). */
export function scrub(text: string): string {
	return text
		.replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, "$1-••••")
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1••••")
		.replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1••••");
}

/**
 * Keeps the most recent entries in memory and mirrors them to a JSONL file,
 * so the log survives a restart. Synchronous writes keep ordering and let it
 * run inside a console hook without async re-entrancy.
 */
export class LogStore {
	private entries: LogEntry[] = [];
	private nextId = 1;
	private writes = 0;

	private readonly file: string;
	private readonly max: number;

	constructor(file: string, max = MAX_ENTRIES) {
		this.file = file;
		this.max = max;
		try {
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const line of lines.slice(-max)) {
				try {
					const e = JSON.parse(line) as LogEntry;
					if (typeof e.at === "number" && typeof e.message === "string") this.entries.push({ ...e, id: this.nextId++ });
				} catch {
					// A torn last line after a crash: skip it.
				}
			}
		} catch {
			// First run.
		}
	}

	add(level: LogLevel, message: string, at = Date.now()): LogEntry {
		const text = scrub(message);
		const entry: LogEntry = { id: this.nextId++, at, level, message: text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text };
		this.entries.push(entry);
		if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, `${JSON.stringify({ at: entry.at, level: entry.level, message: entry.message })}\n`);
			// Rewrite occasionally so the file stays bounded.
			if (++this.writes % this.max === 0) this.rewrite();
		} catch {
			// Logging must never throw into the caller.
		}
		return entry;
	}

	list(level?: LogLevel, limit = 200): LogEntry[] {
		const rows = level ? this.entries.filter((e) => e.level === level) : this.entries;
		return rows.slice(-limit).reverse();
	}

	counts(): { error: number; warn: number } {
		let error = 0;
		for (const e of this.entries) if (e.level === "error") error++;
		return { error, warn: this.entries.length - error };
	}

	clear(): void {
		this.entries = [];
		try {
			writeFileSync(this.file, "");
		} catch {
			// ignore
		}
	}

	private rewrite(): void {
		writeFileSync(this.file, this.entries.map((e) => JSON.stringify({ at: e.at, level: e.level, message: e.message })).join("\n") + "\n");
	}
}

/**
 * Wraps console.error / console.warn so everything the server and its plugins report ends up in `store`.
 * The original methods still run first. Returns a function that restores them.
 */
export function captureConsole(store: LogStore, target: Pick<Console, "error" | "warn"> = console): () => void {
	const original = { error: target.error, warn: target.warn };
	let busy = false;
	const wrap = (level: LogLevel) =>
		function (this: unknown, ...args: unknown[]) {
			original[level].apply(target, args as []);
			if (busy) return;
			busy = true;
			try {
				store.add(level, format(...args));
			} catch {
				// never break the caller
			} finally {
				busy = false;
			}
		};
	target.error = wrap("error");
	target.warn = wrap("warn");
	return () => {
		if (target.error !== original.error) target.error = original.error;
		if (target.warn !== original.warn) target.warn = original.warn;
	};
}
