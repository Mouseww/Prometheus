import { type FlowRefContext, flowHasCycle, flowIssues, flowLoopBackIds, MAX_FLOW_NODES as MAX_NODES } from "@prometheus/protocol";
import type { FlowEdge, FlowInput, FlowNode } from "@prometheus/protocol";

export { MAX_NODES };
const ACCESS = ["readonly", "edits", "full"];
const KINDS = ["start", "agent", "condition", "end", "subflow"];

/** Everything wrong with a flow, in plain language; empty when it can run. */
export function validateFlow(flow: Pick<FlowInput, "name" | "nodes" | "edges">, refs?: FlowRefContext): string[] {
	return flowIssues(flow, refs).map((i) => i.message);
}

export const hasCycle = flowHasCycle;

/** Left-to-right layers by longest path from the roots. Loop-back edges are ignored so a cycle does not collapse the layout. */
export function autoLayout(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
	const back = flowLoopBackIds(nodes, edges);
	const forward = edges.filter((e) => !back.has(e.id));
	const layer = new Map<string, number>();
	const visit = (id: string, guard = 0): number => {
		const known = layer.get(id);
		if (known !== undefined) return known;
		if (guard > nodes.length) return 0;
		const ups = forward.filter((e) => e.to === id).map((e) => visit(e.from, guard + 1) + 1);
		const l = ups.length ? Math.max(...ups) : 0;
		layer.set(id, l);
		return l;
	};
	for (const n of nodes) visit(n.id);
	const rows = new Map<number, number>();
	return nodes.map((n) => {
		const l = layer.get(n.id) ?? 0;
		const row = rows.get(l) ?? 0;
		rows.set(l, row + 1);
		return { ...n, x: 60 + l * 280, y: 60 + row * 150 };
	});
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Turns loosely typed JSON (an AI draft, an RPC payload) into a clean flow body. Unknown fields are dropped.
 * Nodes without a position are laid out automatically.
 */
export function normalizeFlow(raw: unknown): FlowInput {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const rawNodes = Array.isArray(o.nodes) ? o.nodes : [];
	let positioned = true;
	const nodes: FlowNode[] = rawNodes.slice(0, MAX_NODES + 1).map((r, i) => {
		const n = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
		const kind = KINDS.includes(str(n.kind)) ? (str(n.kind) as FlowNode["kind"]) : "agent";
		if (typeof n.x !== "number" || typeof n.y !== "number") positioned = false;
		const model = n.model && typeof n.model === "object" ? (n.model as Record<string, unknown>) : undefined;
		const node: FlowNode = {
			id: str(n.id).trim() || `n${i + 1}`,
			kind,
			x: typeof n.x === "number" ? n.x : 0,
			y: typeof n.y === "number" ? n.y : 0,
			title: str(n.title).trim().slice(0, 60) || (kind === "start" ? "开始" : kind === "end" ? "结束" : kind === "subflow" ? "子流程" : `步骤 ${i + 1}`),
		};
		if (kind === "agent" || kind === "condition" || kind === "subflow") node.prompt = str(n.prompt).trim().slice(0, 8000);
		if (kind === "subflow") node.flowId = str(n.flowId);
		if (kind === "agent") {
			node.access = ACCESS.includes(str(n.access)) ? (str(n.access) as FlowNode["access"]) : "readonly";
			if (model && str(model.provider) && str(model.id)) node.model = { provider: str(model.provider), id: str(model.id) };
		}
		if (kind === "condition") {
			node.mode = ["contains", "regex", "ai"].includes(str(n.mode)) ? (str(n.mode) as FlowNode["mode"]) : "ai";
			if (node.mode !== "ai") node.match = str(n.match).slice(0, 500);
		}
		return node;
	});
	const ids = new Set(nodes.map((n) => n.id));
	const edges: FlowEdge[] = (Array.isArray(o.edges) ? o.edges : []).flatMap((r, i) => {
		const e = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
		const from = str(e.from);
		const to = str(e.to);
		if (!ids.has(from) || !ids.has(to)) return [];
		const branch = e.branch === "true" || e.branch === "false" ? e.branch : undefined;
		return [{ id: str(e.id) || `e${i + 1}`, from, to, ...(branch ? { branch } : {}) }];
	});
	const sched = o.schedule && typeof o.schedule === "object" ? (o.schedule as FlowInput["schedule"]) : undefined;
	return {
		name: str(o.name).trim().slice(0, 80),
		description: str(o.description).trim().slice(0, 500),
		workspaceId: str(o.workspaceId),
		nodes: positioned ? nodes : autoLayout(nodes, edges),
		edges,
		...(sched ? { schedule: sched, scheduleInput: str(o.scheduleInput).slice(0, 8000), scheduleEnabled: o.scheduleEnabled === true, scheduleWorkspaceId: str(o.scheduleWorkspaceId) } : {}),
	};
}

/** Pulls the first balanced JSON object out of an agent reply (code fences and chatter around it are ignored). */
export function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidates = fenced ? [fenced[1]!, text] : [text];
	for (const src of candidates) {
		for (let start = src.indexOf("{"); start >= 0; start = src.indexOf("{", start + 1)) {
			let depth = 0;
			let inStr = false;
			for (let i = start; i < src.length; i++) {
				const c = src[i]!;
				if (inStr) {
					if (c === "\\") i++;
					else if (c === '"') inStr = false;
				} else if (c === '"') inStr = true;
				else if (c === "{") depth++;
				else if (c === "}" && --depth === 0) {
					try {
						return JSON.parse(src.slice(start, i + 1));
					} catch {
						break;
					}
				}
			}
		}
	}
	throw new Error("没有从回复里解析出流程 JSON");
}

export const GENERATE_GUIDE = `你是流程编排设计师。把用户描述的工作流程（SOP）设计成一张流程图，只输出一个 JSON 对象，不要任何解释。
格式：
{"name":"流程名","description":"一句话说明","nodes":[...],"edges":[...]}
节点 kind：
- start：入口，有且仅有一个，id 用 "start"。用户启动时输入的内容可在提示词里用 {{input}} 引用。
- agent：一个由 Agent 执行的步骤。字段 id,title,prompt(完整、自包含的指令),access("readonly"只读|"edits"可改文件但**不能执行命令**|"full"可改文件也可执行命令；默认 readonly)。步骤要跑构建/测试/脚本或任何命令行时，必须给 "full"，否则命令会被拒绝；只读调研才用 "readonly"，不要无谓给高权限。
- condition：分支判断。字段 id,title,mode("ai"用 prompt 写是/否问题|"contains"|"regex"),prompt 或 match。它的每条出线必须带 branch:"true" 或 "false"。需要循环时，把条件的一条分支连回前面要重做的步骤，另一条连到循环外作为出口；不要单独加循环器节点。
- end：可选出口，汇总最终结果。
提示词里可用变量：{{input}} 启动输入，{{prev}} 直接上游步骤的输出，{{节点id}} 指定节点的输出。
edges 形如 {"from":"start","to":"a1"}；并行就让一个节点连向多个下游，汇合就让多个节点连向同一个下游。
类型 subflow：调用另一条已保存的流程。字段 id,title,flowId(下面“可用的子流程”里的 id),prompt(传给子流程的输入，可省略，默认 {{prev}})。子流程的最终输出就是该节点的输出。
步骤要拆得单一明确（3~8 个为宜）。除了条件节点的回边，不要出现没有出口的环。`;

/** An AI draft may forget the entry node: add one in front of every node that has no incoming edge. */
export function ensureStart(flow: FlowInput): FlowInput {
	if (flow.nodes.some((n) => n.kind === "start")) return flow;
	let id = "start";
	while (flow.nodes.some((n) => n.id === id)) id += "_";
	const roots = flow.nodes.filter((n) => !flow.edges.some((e) => e.to === n.id));
	const nodes = autoLayout([{ id, kind: "start", x: 0, y: 0, title: "开始" }, ...flow.nodes], [...flow.edges, ...roots.map((r, i) => ({ id: `s${i}`, from: id, to: r.id }))]);
	return { ...flow, nodes, edges: [...flow.edges, ...roots.map((r, i) => ({ id: `s${i}`, from: id, to: r.id }))] };
}
