import type { CUNode } from "../protocol.ts";
import { isSecretField, MASK, redactText } from "./redact.ts";

/** A node as the model sees it: noise removed, secrets masked, long sibling runs cut. */
export interface PNode {
	ref: string;
	role: string;
	name?: string;
	value?: string;
	states: string[];
	actions: string[];
	children: PNode[];
	/** Siblings cut from the end of `children`. */
	more?: number;
	/** Children the driver itself did not send (its node budget ran out). */
	omitted?: number;
}

const DROP_ROLES = new Set(["scrollbar", "thumb", "separator", "tooltip"]);
const CONTAINER_ROLES = new Set(["pane", "group", "custom", "unknown", "window", "header", "titlebar"]);
const MAX_SIBLINGS = 50;

export interface PruneResult {
	tree: PNode;
	/** Nodes dropped as offscreen or decorative. */
	hidden: number;
}

function countAll(n: CUNode): number {
	let c = 1;
	for (const k of n.children ?? []) c += countAll(k);
	return c;
}

export function prune(root: CUNode): PruneResult {
	let hidden = 0;

	const visit = (n: CUNode, parentName: string | undefined, isRoot: boolean): PNode[] => {
		const states = n.states ?? [];
		if (!isRoot && (DROP_ROLES.has(n.role) || states.includes("offscreen"))) {
			hidden += countAll(n);
			return [];
		}
		const name = n.name?.trim() ? redactText(n.name.trim()) : undefined;
		let value: string | undefined;
		if (isSecretField(states)) value = n.value !== undefined || states.includes("editable") ? MASK : undefined;
		else if (n.value !== undefined && n.value !== "" && n.value !== n.name) value = redactText(n.value, n.name ?? "");

		let children = (n.children ?? []).flatMap((k) => visit(k, name ?? parentName, false));
		let more: number | undefined;
		if (children.length > MAX_SIBLINGS) {
			more = children.length - MAX_SIBLINGS;
			children = children.slice(0, MAX_SIBLINGS);
		}
		const actions = (n.actions ?? []).filter((a) => a !== "scroll" || n.role !== "text");

		if (!isRoot) {
			// Static text repeating its parent's label adds nothing.
			if (n.role === "text" && !children.length && (!name || name === parentName) && !value) {
				hidden++;
				return [];
			}
			// Unnamed layout containers are flattened into their parent.
			const meaningful = name || value || actions.some((a) => a !== "scroll") || states.some((s) => s === "focused" || s === "selected");
			if (CONTAINER_ROLES.has(n.role) && !meaningful) {
				hidden++;
				return children;
			}
		}
		const p: PNode = { ref: n.ref, role: n.role, states, actions, children };
		if (name) p.name = name;
		if (value !== undefined) p.value = value;
		if (more) p.more = more;
		if (n.omitted) p.omitted = n.omitted;
		return [p];
	};

	const [tree] = visit(root, undefined, true);
	return { tree: tree!, hidden };
}

export function* walk(n: PNode, depth = 0, parent?: PNode): Generator<{ node: PNode; depth: number; parent?: PNode }> {
	yield { node: n, depth, parent };
	for (const k of n.children) yield* walk(k, depth + 1, n);
}

export function indexTree(n: PNode): Map<string, { node: PNode; parent?: PNode; depth: number }> {
	const m = new Map<string, { node: PNode; parent?: PNode; depth: number }>();
	for (const e of walk(n)) m.set(e.node.ref, e);
	return m;
}
