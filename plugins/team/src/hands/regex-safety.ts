import { TeamError } from "../types.ts";

export const MAX_PATTERN_LENGTH = 512;
/** Longer lines are cut before matching, which bounds the cost of any pattern that is still slow on long input. */
export const MAX_MATCH_LINE_CHARS = 2000;

interface Group {
	/** An unbounded repeat or an alternation sits somewhere inside. */
	risky: boolean;
}

/** Whether a quantifier starts at `i`; returns its length and whether it can repeat more than once. */
function quantifierAt(p: string, i: number): { len: number; repeats: boolean } | undefined {
	const c = p[i];
	if (c === "*" || c === "+") return { len: 1, repeats: true };
	if (c === "?") return { len: 1, repeats: false };
	if (c !== "{") return undefined;
	const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
	if (!m) return undefined;
	const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
	return { len: m[0].length, repeats: max > 1 };
}

/**
 * A cheap guard against catastrophic backtracking (ReDoS) for patterns a tenant instance sends: rejects overlong patterns, back references,
 * and a repeated group that itself contains a repeat or an alternation, such as `(a+)+`, `(a*)*` or `(a|aa)+`. It errs on the strict side
 * (`(foo|bar)+` is refused too); the caller can write the same search with a character class or without the outer repeat.
 */
export function assertSafePattern(pattern: string): void {
	if (pattern.length > MAX_PATTERN_LENGTH) throw new TeamError("invalidParams", `pattern 太长 (最多 ${MAX_PATTERN_LENGTH} 个字符)`);
	const stack: Group[] = [];
	const markRisky = (): void => {
		const top = stack[stack.length - 1];
		if (top) top.risky = true;
	};
	const reject = (why: string): never => {
		throw new TeamError("invalidParams", `pattern 被拒绝: ${why}。请简化正则表达式`);
	};
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i] as string;
		if (c === "\\") {
			const next = pattern[i + 1] ?? "";
			if (/[1-9]/.test(next) || next === "k") reject("不支持反向引用");
			i++;
			continue;
		}
		if (c === "[") {
			for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
			const q = quantifierAt(pattern, i + 1);
			if (q) {
				if (q.repeats) markRisky();
				i += q.len;
			}
			continue;
		}
		if (c === "(") {
			stack.push({ risky: false });
			continue;
		}
		if (c === "|") {
			markRisky();
			continue;
		}
		if (c === ")") {
			const group = stack.pop();
			const q = quantifierAt(pattern, i + 1);
			if (q?.repeats) {
				if (group?.risky) reject("重复的分组里还含有重复或分支 (可能造成指数级回溯)");
				markRisky();
			} else if (group?.risky) markRisky();
			if (q) i += q.len;
			continue;
		}
		const q = quantifierAt(pattern, i);
		if (q) {
			if (q.repeats) markRisky();
			i += q.len - 1;
		}
	}
}
