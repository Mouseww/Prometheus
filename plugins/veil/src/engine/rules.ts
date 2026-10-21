/**
 * Ordered, non-overlapping rule evaluation. Ported from veil's `rules.rs`.
 *
 * Rules run highest-priority-first. The first rule to claim a span owns it, so `postgres://…`
 * becomes one CONNSTR placeholder instead of a CONNSTR plus the IP inside it.
 */
import { findIpSpans } from "./ip.ts";

export type MatcherKind = "regex" | "dictionary" | "ip";

export interface Rule {
	id: string;
	name: string;
	/** Appears in the placeholder: `{{TYPE_xxxxx}}`. 1..=32 uppercase letters/digits. */
	typePrefix: string;
	enabled: boolean;
	kind: MatcherKind;
	/** Regex source, for `kind: "regex"`. */
	pattern?: string;
	/** Literal words, for `kind: "dictionary"`. */
	words?: string[];
	/** Higher wins. Ties break on `id`, so evaluation is deterministic. */
	priority: number;
}

export interface Hit {
	start: number;
	end: number;
	typePrefix: string;
	plaintext: string;
}

const TYPE_PATTERN = /^[A-Z][A-Z0-9]{0,31}$/;

export class RuleError extends Error {}

const compiled = new WeakMap<Rule, RegExp>();

function regexFor(rule: Rule): RegExp {
	const cached = compiled.get(rule);
	if (cached) return cached;
	let re: RegExp;
	try {
		// Built-ins use leading `(?i)` / `(?s)` groups (Rust syntax); JS wants flags instead.
		const { source, flags } = normalizeInlineFlags(rule.pattern ?? "");
		re = new RegExp(source, flags.includes("g") ? flags : `${flags}g`);
	} catch (err) {
		throw new RuleError(`规则 ${rule.id} 的正则无效：${err instanceof Error ? err.message : String(err)}`);
	}
	compiled.set(rule, re);
	return re;
}

/**
 * Rust regex syntax allows leading `(?i)` / `(?s)` / `(?m)` groups; JS wants flags instead.
 * Only a group at the very start is rewritten, which is how every built-in rule writes it.
 */
function normalizeInlineFlags(pattern: string): { source: string; flags: string } {
	const group = /^\(\?([a-z]+)\)/.exec(pattern);
	if (!group) return { source: pattern, flags: "" };
	const letters = group[1] as string;
	let flags = "";
	if (letters.includes("i")) flags += "i";
	if (letters.includes("m")) flags += "m";
	if (letters.includes("s")) flags += "s";
	return { source: pattern.slice(group[0].length), flags };
}

/** Validates a rule the user typed. Throws with a message meant for the UI. */
export function validateRule(rule: Rule): void {
	if (!rule.id.trim()) throw new RuleError("规则 id 不能为空");
	if (!TYPE_PATTERN.test(rule.typePrefix)) throw new RuleError(`类型 ${rule.typePrefix} 不合法：需大写字母开头，只含大写字母和数字，最长 32 位`);
	if (!Number.isFinite(rule.priority)) throw new RuleError("优先级必须是数字");
	if (rule.kind === "regex") {
		if (!rule.pattern) throw new RuleError("正则规则需要填写正则表达式");
		try {
			new RegExp(rule.pattern);
		} catch (err) {
			throw new RuleError(`正则无效：${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (rule.kind === "dictionary" && !(rule.words ?? []).some((w) => w.length > 0)) throw new RuleError("词表规则至少需要一个词");
}

/** Cached regexes must be dropped when a rule object is copied; callers build fresh objects from config. */
export function loadRules(rules: Rule[]): Rule[] {
	for (const r of rules) {
		if (r.kind === "regex") regexFor(r);
	}
	return [...rules].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface Occupied {
	spans: [number, number][];
}

function gaps(o: Occupied, len: number): [number, number][] {
	const out: [number, number][] = [];
	let cursor = 0;
	for (const [start, end] of o.spans) {
		if (cursor < start) out.push([cursor, start]);
		cursor = Math.max(cursor, end);
	}
	if (cursor < len) out.push([cursor, len]);
	return out;
}

function overlaps(o: Occupied, start: number, end: number): boolean {
	return o.spans.some(([s, e]) => start < e && end > s);
}

function insert(o: Occupied, start: number, end: number): void {
	if (start >= end) return;
	o.spans.push([start, end]);
	o.spans.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [s, e] of o.spans) {
		const last = merged[merged.length - 1];
		if (last && s <= last[1]) last[1] = Math.max(last[1], e);
		else merged.push([s, e]);
	}
	o.spans = merged;
}

function regexSpans(rule: Rule, text: string, gs: number, ge: number): [number, number][] {
	const re = regexFor(rule);
	re.lastIndex = 0;
	const slice = text.slice(gs, ge);
	const spans: [number, number][] = [];
	for (let m = re.exec(slice); m; m = re.exec(slice)) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		spans.push([gs + m.index, gs + m.index + m[0].length]);
	}
	return spans;
}

function dictionarySpans(words: string[], text: string, gs: number, ge: number): [number, number][] {
	const slice = text.slice(gs, ge);
	const spans: [number, number][] = [];
	for (const word of words) {
		if (!word) continue;
		let from = 0;
		for (;;) {
			const at = slice.indexOf(word, from);
			if (at === -1) break;
			spans.push([gs + at, gs + at + word.length]);
			from = at + word.length;
		}
	}
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	return spans;
}

export interface RuleSetOptions {
	rules: Rule[];
	/** Exact strings that are never replaced (loopback addresses by default). */
	allowlist: Iterable<string>;
}

export class RuleSet {
	readonly rules: Rule[];
	private readonly allow: Set<string>;

	constructor(options: RuleSetOptions) {
		this.rules = loadRules(options.rules);
		this.allow = new Set(options.allowlist);
	}

	/** Every match, ordered by position, non-overlapping. */
	findHits(text: string): Hit[] {
		const occupied: Occupied = { spans: [] };
		const hits: Hit[] = [];

		for (const rule of this.rules) {
			if (!rule.enabled) continue;
			const taken: [number, number][] = [];
			const candidates: [number, number][] = [];
			for (const [gs, ge] of gaps(occupied, text.length)) {
				if (gs >= ge) continue;
				if (rule.kind === "ip") candidates.push(...findIpSpans(text.slice(gs, ge)).map(([s, e]) => [gs + s, gs + e] as [number, number]));
				else if (rule.kind === "dictionary") candidates.push(...dictionarySpans(rule.words ?? [], text, gs, ge));
				else candidates.push(...regexSpans(rule, text, gs, ge));
			}
			candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

			for (const [start, end] of candidates) {
				if (start >= end || end > text.length) continue;
				if (overlaps(occupied, start, end) || taken.some(([s, e]) => start < e && end > s)) continue;
				const plaintext = text.slice(start, end);
				if (this.allow.has(plaintext)) continue;
				taken.push([start, end]);
				hits.push({ start, end, typePrefix: rule.typePrefix, plaintext });
			}
			for (const [s, e] of taken) insert(occupied, s, e);
		}

		hits.sort((a, b) => a.start - b.start);
		return hits;
	}
}

// ---------- built-in rule packs (veil's `builtin.rs`) ----------

export const DEFAULT_ALLOWLIST = ["127.0.0.1", "localhost", "0.0.0.0", "::1"];

export interface PackFlags {
	secrets: boolean;
	region: boolean;
}

const rule = (id: string, typePrefix: string, pattern: string, priority: number, enabled = true): Rule => ({
	id,
	name: id,
	typePrefix,
	enabled,
	kind: "regex",
	pattern,
	priority,
});

/** veil's shipped rule set: a `secrets` pack and a `region` pack. */
export function builtinRules(packs: PackFlags = { secrets: true, region: true }): Rule[] {
	const rules: Rule[] = [];

	if (packs.secrets) {
		rules.push(
			rule("pem", "PEM", String.raw`-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----`, 220),
			rule(
				"apikey",
				"APIKEY",
				String.raw`(?:api[_-]?key|access[_-]?key)\s*[:=]\s*\S{8,}|(?<![A-Za-z0-9])(?:sk-ant-|sk-|rk-|pk-live-|pk-test-|xai-|ghp_|gho_|github_pat_|AIza)[A-Za-z0-9_\-]{8,}|AKIA[0-9A-Z]{16}`,
				210,
			),
			rule(
				"token",
				"TOKEN",
				String.raw`(?:api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[:=]\s*\S{8,}|Bearer\s+[A-Za-z0-9\-._~+/]+=*|(?<![A-Za-z0-9])(?:xox[baprs]-|glpat-|npm_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)`,
				205,
			),
			rule(
				"connstr",
				"CONNSTR",
				String.raw`(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|mssql|sqlserver|mariadb|amqp|amqps|jdbc:\w+)://\S+|(?:Server|Data Source|Initial Catalog)\s*=\s*[^;]+|(?:Pwd|Password|PWD)\s*=\s*[^;\s"]+`,
				180,
			),
			rule("password", "PASSWORD", String.raw`(?:password|passwd|passphrase|login[_-]?password|登录密码|口令)\s*[:=]\s*(?:['"][^'"]{4,}['"]|\S{4,})`, 170),
			rule("idcard", "IDCARD", String.raw`(?<!\d)\d{17}[\dXx](?!\d)`, 150),
			rule("phone", "PHONE", String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`, 140),
			{ id: "ip", name: "ip", typePrefix: "IP", enabled: true, kind: "ip", priority: 120 },
			rule("email", "EMAIL", String.raw`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`, 80, false),
		);
	}

	if (packs.region) {
		rules.push(
			{
				id: "timezone",
				name: "timezone",
				typePrefix: "TZ",
				enabled: true,
				kind: "dictionary",
				words: ["Asia/Shanghai", "Asia/Chongqing", "Asia/Urumqi", "Asia/Harbin", "Asia/Hong_Kong"],
				priority: 115,
			},
			rule("locale", "LOCALE", String.raw`(?<![A-Za-z0-9])(?:zh[-_]CN|zh-Hans)(?![A-Za-z0-9])`, 110),
		);
	}

	return rules;
}
