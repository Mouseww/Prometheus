import { type PNode, walk } from "./prune.ts";

/** Roles whose primary action is a click, so "click" need not be printed. */
const CLICKABLE = new Set(["button", "link", "menuitem", "tab", "listitem", "treeitem", "radio", "checkbox", "row", "columnheader"]);
const SHOWN_STATES = ["focused", "disabled", "checked", "unchecked", "mixed", "selected", "expanded", "collapsed", "editable", "password"];

/** Rough token count: ASCII ~4 chars per token, CJK and other scripts ~1 per char. */
export function estimateTokens(s: string): number {
	let t = 0;
	for (let i = 0; i < s.length; i++) t += s.charCodeAt(i) < 128 ? 0.25 : 1;
	return Math.ceil(t);
}

function clip(s: string, max: number): string {
	const flat = s.replace(/\r?\n/g, "⏎").replace(/\s+/g, " ");
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function q(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`;
}

/** One line for one node, without indentation. */
export function formatNode(n: PNode): string {
	let line = `[${n.ref}] ${n.role}`;
	if (n.name) line += ` ${q(clip(n.name, 100))}`;
	if (n.value !== undefined) {
		line += ` = ${q(clip(n.value, 160))}`;
		if (n.value.length > 160) line += ` (${n.value.length} 字符)`;
	}
	const states = SHOWN_STATES.filter((s) => n.states.includes(s));
	if (states.length) line += ` ${states.join(" ")}`;
	const implied = new Set<string>();
	if (CLICKABLE.has(n.role)) implied.add("click");
	if (n.states.includes("editable")) ["set_value", "type", "clear"].forEach((a) => implied.add(a));
	if (n.states.some((s) => s === "checked" || s === "unchecked" || s === "mixed")) implied.add("toggle");
	if (n.states.some((s) => s === "expanded" || s === "collapsed")) ["expand", "collapse"].forEach((a) => implied.add(a));
	if (["listitem", "tab", "treeitem", "radio", "row"].includes(n.role)) implied.add("select");
	const extra = n.actions.filter((a) => !implied.has(a));
	if (extra.length) line += ` {${extra.join(",")}}`;
	return line;
}

export interface RenderOptions {
	/** Token budget for the tree part. */
	budget: number;
	focus?: string;
	/** Keep only nodes matching any word of this (plus their ancestors). */
	query?: string;
}

export interface RenderResult {
	text: string;
	shown: number;
	total: number;
	cut: number;
}

function priority(n: PNode, onFocusPath: boolean): number {
	if (onFocusPath) return 100;
	if (n.states.includes("editable") || n.actions.some((a) => a !== "scroll")) return 50;
	if (n.value !== undefined) return 40;
	if (n.name) return n.role === "text" ? 25 : 30;
	return 10;
}

export function matchesQuery(n: PNode, words: string[]): boolean {
	const hay = `${n.role} ${n.name ?? ""} ${n.value ?? ""}`.toLowerCase();
	return words.some((w) => hay.includes(w));
}

export function render(tree: PNode, opts: RenderOptions): RenderResult {
	type Entry = { node: PNode; depth: number; parent: number; line: string; cost: number };
	const entries: Entry[] = [];
	const indexOf = new Map<PNode, number>();
	for (const { node, depth, parent } of walk(tree)) {
		const line = formatNode(node);
		indexOf.set(node, entries.length);
		entries.push({ node, depth, parent: parent ? indexOf.get(parent)! : -1, line, cost: estimateTokens(line) + depth * 0.5 });
	}

	const keep = new Set<number>();
	const addWithAncestors = (i: number): number => {
		let added = 0;
		for (let j = i; j >= 0 && !keep.has(j); j = entries[j]!.parent) {
			keep.add(j);
			added += entries[j]!.cost;
		}
		return added;
	};

	// Focus path first, then by priority until the budget runs out.
	const focusPath = new Set<number>();
	if (opts.focus) {
		const fi = entries.findIndex((e) => e.node.ref === opts.focus);
		for (let j = fi; j >= 0; j = entries[j]!.parent) focusPath.add(j);
	}
	let candidates = entries.map((_, i) => i);
	if (opts.query?.trim()) {
		const words = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
		candidates = candidates.filter((i) => matchesQuery(entries[i]!.node, words));
	}
	const total = entries.reduce((s, e) => s + e.cost, 0);
	let used = 0;
	if (!opts.query && total <= opts.budget) {
		candidates.forEach((i) => keep.add(i));
	} else {
		const order = [...candidates].sort((a, b) => {
			const pa = priority(entries[a]!.node, focusPath.has(a));
			const pb = priority(entries[b]!.node, focusPath.has(b));
			return pb - pa || a - b;
		});
		keep.add(0);
		used = entries[0]!.cost;
		for (const i of order) {
			if (keep.has(i)) continue;
			let extra = 0;
			for (let j = i; j >= 0 && !keep.has(j); j = entries[j]!.parent) extra += entries[j]!.cost;
			if (used + extra > opts.budget) continue;
			used += addWithAncestors(i);
		}
	}

	const lines: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (!keep.has(i)) continue;
		const e = entries[i]!;
		const pad = "  ".repeat(e.depth);
		lines.push(pad + e.line);
		const kids = e.node.children;
		const hiddenKids = kids.filter((k) => !keep.has(indexOf.get(k)!)).length;
		const notes: string[] = [];
		if (hiddenKids && kids.length) notes.push(`${hiddenKids} 个子元素未显示`);
		if (e.node.more) notes.push(`另有 ${e.node.more} 项`);
		if (e.node.omitted) notes.push(`驱动省略 ${e.node.omitted} 项`);
		if (notes.length && (hiddenKids < kids.length || e.node.more || e.node.omitted)) {
			lines.push(`${pad}  … ${notes.join("，")}（用 scope=${e.node.ref} 或 query 展开）`);
		} else if (hiddenKids && hiddenKids === kids.length && kids.length > 0) {
			lines.push(`${pad}  … ${hiddenKids} 个子元素（scope=${e.node.ref}）`);
		}
	}
	return { text: lines.join("\n"), shown: keep.size, total: entries.length, cut: entries.length - keep.size };
}
