// Flow (agent orchestration) checks shared by the plugin that runs flows and the editor that draws them,
// so the editor can point at the exact node that is wrong before anything is saved.
import type { FlowEdge, FlowNode } from "./index.ts";

export const MAX_FLOW_NODES = 40;
const ACCESS = ["readonly", "edits", "full"];
const KINDS = ["start", "agent", "condition", "end", "subflow"];
/** How many flows may call each other in a chain; a run deeper than this is refused. */
export const MAX_SUBFLOW_DEPTH = 3;

export interface FlowIssue {
	/** The node to highlight, when the problem belongs to one. */
	nodeId?: string;
	edgeId?: string;
	message: string;
}

export function flowHasCycle(nodes: FlowNode[], edges: FlowEdge[]): boolean {
	const indeg = new Map(nodes.map((n) => [n.id, 0]));
	for (const e of edges) if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
	const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
	let done = 0;
	while (queue.length) {
		const id = queue.shift()!;
		done++;
		for (const e of edges) {
			if (e.from !== id || !indeg.has(e.to)) continue;
			const d = (indeg.get(e.to) ?? 0) - 1;
			indeg.set(e.to, d);
			if (d === 0) queue.push(e.to);
		}
	}
	return done < nodes.length;
}

function reachableFrom(start: string, edges: FlowEdge[]): Set<string> {
	const seen = new Set([start]);
	const stack = [start];
	while (stack.length) {
		const id = stack.pop()!;
		for (const e of edges) if (e.from === id && !seen.has(e.to)) (seen.add(e.to), stack.push(e.to));
	}
	return seen;
}

/** Everything that stops a flow from running, each tied to a node where possible. Empty means it can run. */
export interface FlowRefContext {
	/** This flow's own id (absent while it is unsaved). */
	selfId?: string;
	/** Every saved flow, for resolving subflow references. */
	flows: { id: string; name: string; nodes: FlowNode[] }[];
}

/** The flow that `start` would reach again by following subflow references, as a chain of names; undefined when there is no loop. */
function subflowLoop(start: { id?: string; name: string; nodes: FlowNode[] }, flows: FlowRefContext["flows"]): string[] | undefined {
	const byId = new Map(flows.map((f) => [f.id, f]));
	const walk = (nodes: FlowNode[], path: string[]): string[] | undefined => {
		for (const n of nodes) {
			if (n.kind !== "subflow" || !n.flowId) continue;
			const target = byId.get(n.flowId);
			if (!target) continue;
			if (n.flowId === start.id) return [...path, target.name];
			if (path.length > 12 || path.includes(target.name)) continue;
			const hit = walk(target.nodes, [...path, target.name]);
			if (hit) return hit;
		}
		return undefined;
	};
	return walk(start.nodes, [start.name]);
}

export function flowIssues(flow: { name: string; nodes: FlowNode[]; edges: FlowEdge[] }, refs?: FlowRefContext): FlowIssue[] {
	const out: FlowIssue[] = [];
	const add = (message: string, nodeId?: string, edgeId?: string) => out.push({ message, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) });
	if (!flow.name?.trim()) add("名称不能为空");
	const { nodes, edges } = flow;
	if (nodes.length > MAX_FLOW_NODES) add(`节点数不能超过 ${MAX_FLOW_NODES}`);
	const ids = new Set<string>();
	for (const n of nodes) {
		if (!n.id || ids.has(n.id)) add(`节点 ID 重复或为空：${n.id}`, n.id);
		ids.add(n.id);
		if (!KINDS.includes(n.kind)) add(`节点「${n.title}」类型不合法`, n.id);
		if (n.kind === "agent" && !n.prompt?.trim()) add(`步骤「${n.title}」没有填写指令`, n.id);
		if (n.kind === "subflow") {
			if (!n.flowId) add(`子流程「${n.title}」还没有选择要调用的流程`, n.id);
			else if (refs) {
				if (n.flowId === refs.selfId) add(`子流程「${n.title}」不能调用流程自己`, n.id);
				else if (!refs.flows.some((f) => f.id === n.flowId)) add(`子流程「${n.title}」调用的流程已被删除`, n.id);
			}
		}
		if (n.kind === "agent" && n.access && !ACCESS.includes(n.access)) add(`步骤「${n.title}」权限不合法`, n.id);
		if (n.kind === "condition") {
			const mode = n.mode ?? "contains";
			if (!n.prompt?.trim() && mode === "ai") add(`条件「${n.title}」没有填写判断问题`, n.id);
			if (mode !== "ai" && !n.match?.trim()) add(`条件「${n.title}」没有填写匹配内容`, n.id);
			if (mode === "regex" && n.match) {
				try {
					new RegExp(n.match);
				} catch {
					add(`条件「${n.title}」的正则不合法`, n.id);
				}
			}
			const outs = edges.filter((e) => e.from === n.id);
			if (!outs.some((e) => e.branch === "true") && !outs.some((e) => e.branch === "false")) add(`条件「${n.title}」还没有连出任何分支`, n.id);
		}
	}
	const starts = nodes.filter((n) => n.kind === "start");
	if (starts.length !== 1) add("必须有且只有一个开始节点", starts[1]?.id);
	if (!nodes.some((n) => n.kind === "agent" || n.kind === "subflow")) add("至少需要一个 Agent 步骤");
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const seen = new Set<string>();
	for (const e of edges) {
		const from = byId.get(e.from);
		const to = byId.get(e.to);
		if (!from || !to) {
			add("连线指向了不存在的节点", undefined, e.id);
			continue;
		}
		if (e.from === e.to) add(`「${from.title}」不能连到自己`, from.id, e.id);
		if (to.kind === "start") add("开始节点不能有入线", to.id, e.id);
		if (from.kind === "end") add("结束节点不能有出线", from.id, e.id);
		if (from.kind === "condition" && e.branch !== "true" && e.branch !== "false") add(`条件「${from.title}」的出线必须标明是/否`, from.id, e.id);
		const key = `${e.from}>${e.to}>${e.branch ?? ""}`;
		if (seen.has(key)) add("存在重复连线", from.id, e.id);
		seen.add(key);
	}
	if (refs && refs.selfId) {
		const loop = subflowLoop({ id: refs.selfId, name: flow.name, nodes }, refs.flows);
		if (loop) add(`子流程形成了循环调用：${loop.join(" → ")}`);
	}
	if (flowHasCycle(nodes, edges)) add("流程中存在环，目前只支持有向无环图");
	else if (starts.length === 1) {
		const reach = reachableFrom(starts[0]!.id, edges);
		for (const n of nodes) if (!reach.has(n.id)) add(`节点「${n.title}」从开始节点无法到达`, n.id);
	}
	return out;
}
