import { indexTree, type PNode, walk } from "./prune.ts";
import { formatNode, render } from "./render.ts";

export interface DiffResult {
	text: string;
	/** Number of added + removed + changed nodes. */
	changes: number;
	/** Too much changed to describe as a diff; the caller should show a fresh snapshot instead. */
	big: boolean;
}

const sig = (n: PNode) => `${n.role}|${n.name ?? ""}|${n.value ?? ""}|${[...n.states].sort().join(",")}`;

/** "+disabled" style change when only states differ, else undefined. */
function stateOnly(a: PNode, b: PNode): string | undefined {
	if (a.role !== b.role || (a.name ?? "") !== (b.name ?? "") || (a.value ?? "") !== (b.value ?? "")) return undefined;
	const gained = b.states.filter((s) => !a.states.includes(s) && s !== "offscreen");
	const lost = a.states.filter((s) => !b.states.includes(s) && s !== "offscreen");
	return [...gained.map((s) => `+${s}`), ...lost.map((s) => `-${s}`)].join(" ");
}

function describeChange(a: PNode, b: PNode): string {
	const parts: string[] = [];
	if (a.role !== b.role) parts.push(`role ${a.role}→${b.role}`);
	if ((a.name ?? "") !== (b.name ?? "")) parts.push(`name "${a.name ?? ""}"→"${b.name ?? ""}"`);
	if ((a.value ?? "") !== (b.value ?? "")) {
		const v = b.value ?? "";
		parts.push(`value → "${v.length > 160 ? `${v.slice(0, 160)}…` : v}"`);
	}
	const gained = b.states.filter((s) => !a.states.includes(s) && s !== "offscreen");
	const lost = a.states.filter((s) => !b.states.includes(s) && s !== "offscreen");
	if (gained.length) parts.push(`+${gained.join(" +")}`);
	if (lost.length) parts.push(`-${lost.join(" -")}`);
	return `~ [${b.ref}] ${b.role}${b.name ? ` "${b.name.slice(0, 60)}"` : ""}: ${parts.join("; ")}`;
}

/**
 * What changed between two pruned snapshots of the same window. Refs are stable, so a node is
 * "the same" when its ref is; additions and removals are reported at their top-most node only.
 */
export function diff(prev: PNode, next: PNode, maxLines = 40, focus?: string): DiffResult {
	const a = indexTree(prev);
	const b = indexTree(next);
	const lines: string[] = [];
	let changes = 0;
	// Identical state-only changes (a modal dialog disabling a whole window) collapse into one line.
	const groups = new Map<string, PNode[]>();

	for (const { node, parent } of walk(next)) {
		if (a.has(node.ref)) {
			const old = a.get(node.ref)!.node;
			if (sig(old) !== sig(node)) {
				changes++;
				const only = stateOnly(old, node);
				if (only) {
					if (!groups.has(only)) {
						groups.set(only, []);
						lines.push(`\u0000${only}`);
					}
					groups.get(only)!.push(node);
				} else lines.push(describeChange(old, node));
			}
			continue;
		}
		changes++;
		// Only the top of a new subtree gets a header; its descendants follow indented.
		if (parent && !a.has(parent.ref)) continue;
		const sub = [...walk(node, 0)];
		if (sub.length <= 15) {
			for (const e of sub) lines.push(`+ ${"  ".repeat(e.depth)}${formatNode(e.node)}`);
		} else {
			// A big new subtree (a dialog): keep its focus path and controls, like a snapshot would.
			for (const l of render(node, { budget: 450, focus }).text.split("\n")) lines.push(`+ ${l}`);
		}
	}
	for (const { node, parent } of walk(prev)) {
		if (b.has(node.ref)) continue;
		changes++;
		if (parent && !b.has(parent.ref)) continue;
		let count = -1;
		for (const _ of walk(node)) count++;
		lines.push(`- [${node.ref}] ${node.role}${node.name ? ` "${node.name.slice(0, 60)}"` : ""}${count > 0 ? `（含 ${count} 个子元素）` : ""}`);
	}
	const out = lines.map((l) => {
		if (!l.startsWith("\u0000")) return l;
		const key = l.slice(1);
		const nodes = groups.get(key)!;
		if (nodes.length === 1) return `~ [${nodes[0]!.ref}] ${nodes[0]!.role}${nodes[0]!.name ? ` "${nodes[0]!.name.slice(0, 60)}"` : ""}: ${key}`;
		const refs = nodes.slice(0, 8).map((n) => n.ref).join(", ");
		return `~ ${nodes.length} \u4e2a\u5143\u7d20 ${key}\uff08${refs}${nodes.length > 8 ? " \u2026" : ""}\uff09`;
	});
	return { text: out.join("\n"), changes, big: out.length > maxLines };
}

/** Cheap fingerprint for "has the UI stopped changing". */
export function treeSignature(n: PNode): string {
	let h = 0;
	for (const { node } of walk(n)) {
		const s = `${node.ref}|${sig(node)};`;
		for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
	}
	return h.toString(36);
}
