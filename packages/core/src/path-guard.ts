import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Same separators the permission rules split a shell command on; duplicated here so the two files do not import each other. */
const SEPARATORS = /&&|\|\||[;|&\r\n]/;

/**
 * An absolute path for a tool argument, the way the agent's own file tools resolve it: a leading `@` is dropped,
 * `file://` URLs become paths, `~` and `~/` mean the home folder, and on Windows Git-Bash's `/c/...` means `C:\...`.
 * Throws on anything that cannot be understood, so callers can fail closed.
 */
export function normalizeToolPath(raw: string, cwd: string): string {
	let p = raw.replace(/^@/, "");
	if (/^file:\/\//i.test(p)) p = fileURLToPath(p);
	else if (p === "~") p = homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(2));
	else if (process.platform === "win32") {
		const m = /^\/([A-Za-z])(?:[\\/](.*))?$/s.exec(p);
		if (m) p = `${m[1]?.toUpperCase()}:\\${m[2] ?? ""}`;
	}
	return resolve(cwd, p);
}

/** Real location of `p`, or of its nearest existing ancestor with the missing tail appended. Throws on anything but "does not exist". */
function realNearest(p: string): string {
	const tail: string[] = [];
	let cur = p;
	for (;;) {
		try {
			return join(realpathSync.native(cur), ...[...tail].reverse());
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			// A dangling symlink is not "missing": where it points is unknown, so refuse.
			try {
				lstatSync(cur);
				throw new Error("dangling link");
			} catch (inner) {
				if ((inner as Error).message === "dangling link") throw inner;
			}
			const parent = dirname(cur);
			if (parent === cur) throw err;
			tail.push(basename(cur));
			cur = parent;
		}
	}
}

/**
 * Whether `path` lies within `cwd` once symlinks are resolved (no other restriction: `.git` counts as inside).
 * Any error, an unreadable link or a malformed URL answers false.
 */
export function isInside(path: string, cwd: string): boolean {
	try {
		const target = realNearest(normalizeToolPath(path, cwd));
		const root = realNearest(resolve(cwd));
		const rel = relative(root, target);
		return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
	} catch {
		return false;
	}
}

const QUOTES = /["'\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F]/;
const FORBIDDEN = /[$%:~`]/;

/** Splits one command segment into words with every kind of quote removed and quoted pieces joined; undefined when a quote never closes. */
function unquoteWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let cur = "";
	let started = false;
	let quote: string | undefined;
	const closer = (open: string): string => (open === "'" || /[\u2018\u2019\u201A\u201B]/.test(open) ? "'" : '"');
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i] as string;
		if (quote === undefined) {
			if (QUOTES.test(ch)) {
				quote = closer(ch);
				started = true;
			} else if (/\s/.test(ch)) {
				if (started) words.push(cur);
				cur = "";
				started = false;
			} else {
				// A backslash before a quote changes where the quote ends depending on the shell; do not guess.
				if (ch === "\\" && QUOTES.test(segment[i + 1] ?? "")) return undefined;
				cur += ch;
				started = true;
			}
		} else if (QUOTES.test(ch) && closer(ch) === quote) {
			quote = undefined;
		} else {
			if (ch === "\\" && QUOTES.test(segment[i + 1] ?? "")) return undefined;
			cur += ch;
		}
	}
	if (quote !== undefined) return undefined;
	if (started) words.push(cur);
	return words;
}

const hasDotDot = (s: string): boolean => s.includes("..");

/** A plain relative path: nothing that expands, no way up, not absolute, and (links resolved) still inside `cwd`. */
function plainRelativeInside(word: string, cwd: string): boolean {
	if (FORBIDDEN.test(word) || QUOTES.test(word)) return false;
	if (word.startsWith("/") || word.startsWith("\\")) return false;
	if (word.split(/[\\/]/).includes("..")) return false;
	return isInside(word, cwd);
}

function flagStaysInside(flag: string, cwd: string): boolean {
	if (flag.includes("$") || flag.includes("`") || QUOTES.test(flag)) return false;
	const sepAt = flag.search(/[=:]/);
	let value: string;
	if (sepAt >= 0) value = flag.slice(sepAt + 1);
	else if (!flag.startsWith("--") && flag.length > 2) value = flag.slice(2);
	else value = "";
	if (!value) return true;
	if (FORBIDDEN.test(value) || hasDotDot(value) || /[\\/]/.test(value)) return plainRelativeInside(value, cwd);
	return true;
}

function wordStaysInside(word: string, cwd: string): boolean {
	if (word === "-" || word === "--") return true;
	if (word.startsWith("-")) return flagStaysInside(word, cwd);
	return plainRelativeInside(word, cwd);
}

/**
 * Allowlist for read-only shell commands under `readOutsideProject = "ask"`: true only when every argument is a flag
 * without a path-like value or a plain relative path that stays inside `cwd`. Anything unusual (variables, `~`, drive
 * letters, `..`, unbalanced quotes, links leading out) is false, so the caller asks.
 */
export function commandStaysInside(command: string, cwd: string): boolean {
	for (const segment of command.split(SEPARATORS)) {
		if (!segment.trim()) continue;
		const words = unquoteWords(segment);
		if (!words) return false;
		if (!words.slice(1).every((w) => wordStaysInside(w, cwd))) return false;
	}
	return true;
}
