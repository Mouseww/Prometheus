// The page's accessibility tree (Chromium's, through CDP) in the node shape the computer-use engine prunes, renders
// and diffs. Refs are `e<backendNodeId>`: stable while the element lives, so a diff after an action lines up.
import type { CUNode } from "@prometheus/plugin-computer-use/protocol.ts";
import type { Tab } from "./tab.ts";

interface AXValue {
	type: string;
	value?: unknown;
}
interface AXProperty {
	name: string;
	value: AXValue;
}
export interface AXNode {
	nodeId: string;
	ignored?: boolean;
	role?: AXValue;
	name?: AXValue;
	value?: AXValue;
	description?: AXValue;
	properties?: AXProperty[];
	childIds?: string[];
	parentId?: string;
	backendDOMNodeId?: number;
	frameId?: string;
}

const DROP = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
const GROUP = new Set(["generic", "none", "presentation", "Section", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Div", "Pre", "Abbr", "Ruby", "time", "Canvas", "Unknown", "group", "DescriptionListDetail", "DescriptionListTerm", "Legend", "Figcaption"]);
const RENAME: Record<string, string> = {
	RootWebArea: "document",
	WebArea: "document",
	StaticText: "text",
	image: "image",
	img: "image",
	Iframe: "frame",
	IframePresentational: "frame",
	LabelText: "label",
	paragraph: "paragraph",
	MenuListPopup: "listbox",
	MenuListOption: "option",
};
const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);
const TEXT_ENTRY = new Set(["textbox", "searchbox", "spinbutton"]);

const str = (v: AXValue | undefined): string | undefined => {
	if (!v || v.value === undefined || v.value === null) return undefined;
	const s = typeof v.value === "string" ? v.value : typeof v.value === "number" || typeof v.value === "boolean" ? String(v.value) : undefined;
	return s?.trim() ? s : undefined;
};

function roleOf(n: AXNode): string | null {
	const raw = typeof n.role?.value === "string" ? n.role.value : "unknown";
	if (DROP.has(raw)) return null;
	if (raw === "heading") {
		const level = n.properties?.find((p) => p.name === "level")?.value.value;
		return typeof level === "number" ? `h${level}` : "heading";
	}
	if (GROUP.has(raw)) return "group";
	return RENAME[raw] ?? raw.toLowerCase();
}

function statesOf(n: AXNode, role: string, secret: boolean): string[] {
	const out: string[] = [];
	const props = new Map((n.properties ?? []).map((p) => [p.name, p.value.value]));
	if (props.get("focused") === true) out.push("focused");
	if (props.get("disabled") === true) out.push("disabled");
	const checked = props.get("checked") ?? props.get("pressed");
	if (CHECKABLE.has(role) || props.has("checked") || props.has("pressed")) {
		if (checked === "true" || checked === true) out.push("checked");
		else if (checked === "mixed") out.push("mixed");
		else if (checked === "false" || checked === false) out.push("unchecked");
	}
	if (props.has("expanded")) out.push(props.get("expanded") === true ? "expanded" : "collapsed");
	if (props.get("selected") === true) out.push("selected");
	const editable = props.get("editable");
	if ((editable === "plaintext" || editable === "richtext" || TEXT_ENTRY.has(role)) && props.get("readonly") !== true && props.get("disabled") !== true) out.push("editable");
	if (props.get("required") === true) out.push("required");
	if (props.get("invalid") && props.get("invalid") !== "false") out.push("invalid");
	if (secret) out.push("password");
	return out;
}

export interface TreeInput {
	nodes: AXNode[];
	/** Frame trees grafted under the iframe element that owns them, by its backend node id. */
	frames?: Map<number, AXNode[]>;
	/** backendNodeIds of <input type=password>. */
	secrets?: Set<number>;
}

/** Converts a CDP accessibility tree into one CUNode tree; returns the focused ref too. */
export function toCUTree(input: TreeInput): { root: CUNode; focus?: string; count: number } {
	let focus: string | undefined;
	let count = 0;
	const build = (nodes: AXNode[], depth: number): CUNode[] => {
		const byId = new Map(nodes.map((n) => [n.nodeId, n]));
		const root = nodes.find((n) => !n.parentId) ?? nodes[0];
		if (!root) return [];
		const visit = (n: AXNode): CUNode[] => {
			const kids = (n.childIds ?? []).map((id) => byId.get(id)).filter((k): k is AXNode => !!k);
			const childNodes = () => kids.flatMap(visit);
			if (n.ignored) return childNodes();
			const role = roleOf(n);
			if (role === null) return [];
			count++;
			const secret = n.backendDOMNodeId !== undefined && !!input.secrets?.has(n.backendDOMNodeId);
			const ref = n.backendDOMNodeId !== undefined ? `e${n.backendDOMNodeId}` : `a${n.nodeId}`;
			const states = statesOf(n, role, secret);
			if (states.includes("focused")) focus = ref;
			const node: CUNode = { ref, role, states };
			const name = str(n.name);
			if (name) node.name = name;
			let value = str(n.value);
			if (!value && role === "link") {
				const url = n.properties?.find((p) => p.name === "url")?.value.value;
				if (typeof url === "string" && !url.startsWith("javascript:")) value = url;
			}
			if (value !== undefined) node.value = value;
			const desc = str(n.description);
			if (desc) node.description = desc;
			let children = childNodes();
			const sub = n.backendDOMNodeId !== undefined ? input.frames?.get(n.backendDOMNodeId) : undefined;
			if (sub && depth < 4) children = [...children, ...build(sub, depth + 1)];
			if (children.length) node.children = children;
			return [node];
		};
		return visit(root);
	};
	const [top] = build(input.nodes, 0);
	return { root: top ?? { ref: "doc", role: "document", states: [] }, focus, count };
}

/** Reads the active document's tree, same-process iframes included. */
export async function readTree(tab: Tab): Promise<{ root: CUNode; focus?: string; count: number; skippedFrames: number }> {
	await tab.ensureAccessibility();
	const main = await tab.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", {}, 20_000);
	const frames = new Map<number, AXNode[]>();
	let skippedFrames = 0;
	const tree = await tab.send<{ frameTree: FrameTree }>("Page.getFrameTree").catch(() => undefined);
	const children: FrameTree[] = [];
	const collect = (f: FrameTree) => {
		for (const c of f.childFrames ?? []) {
			children.push(c);
			collect(c);
		}
	};
	if (tree) collect(tree.frameTree);
	for (const f of children.slice(0, 20)) {
		try {
			const owner = await tab.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: f.frame.id });
			const sub = await tab.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree", { frameId: f.frame.id }, 10_000);
			if (sub.nodes.length) frames.set(owner.backendNodeId, sub.nodes);
		} catch {
			// Cross-origin frames run in another process this session cannot read.
			skippedFrames++;
		}
	}
	const secrets = await passwordFields(tab);
	return { ...toCUTree({ nodes: main.nodes, frames, secrets }), skippedFrames };
}

interface FrameTree {
	frame: { id: string; url: string };
	childFrames?: FrameTree[];
}

async function passwordFields(tab: Tab): Promise<Set<number>> {
	const out = new Set<number>();
	try {
		const doc = await tab.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
		const { nodeIds } = await tab.send<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: "input[type=password]" });
		for (const nodeId of nodeIds.slice(0, 50)) {
			const d = await tab.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
			out.add(d.node.backendNodeId);
		}
	} catch {
		// Without it, password values still come through masked by Chromium itself.
	}
	return out;
}

export function backendIdOf(ref: string): number | undefined {
	const m = /^e(\d+)$/.exec(ref.trim());
	return m ? Number(m[1]) : undefined;
}
