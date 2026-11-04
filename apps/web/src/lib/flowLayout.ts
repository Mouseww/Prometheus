import type { FlowEdge, FlowNode } from "@prometheus/protocol";

export const NODE_W = 200;
export const NODE_H = 76;

/** Left-to-right layers by longest path from the roots; siblings stack downward. */
export function layoutFlow(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
	const layer = new Map<string, number>();
	const visit = (id: string, guard = 0): number => {
		const known = layer.get(id);
		if (known !== undefined) return known;
		if (guard > nodes.length) return 0;
		const ups = edges.filter((e) => e.to === id).map((e) => visit(e.from, guard + 1) + 1);
		const l = ups.length ? Math.max(...ups) : 0;
		layer.set(id, l);
		return l;
	};
	nodes.forEach((n) => visit(n.id));
	const rows = new Map<number, number>();
	return nodes.map((n) => {
		const l = layer.get(n.id) ?? 0;
		const r = rows.get(l) ?? 0;
		rows.set(l, r + 1);
		return { ...n, x: 60 + l * 280, y: 60 + r * 130 };
	});
}

/** Steps finished so far. A failed or cancelled run does not count the steps it skipped as done. */
export function runProgress(nodes: FlowNode[], run: { status: string; nodes: Record<string, { status: string }> }): { done: number; total: number; current: string[] } {
	const work = nodes.filter((n) => n.kind === "agent" || n.kind === "condition" || n.kind === "subflow");
	const finished = run.status === "error" || run.status === "cancelled" ? ["success"] : ["success", "skipped"];
	return {
		done: work.filter((n) => finished.includes(run.nodes[n.id]?.status ?? "")).length,
		total: work.length,
		current: work.filter((n) => run.nodes[n.id]?.status === "running").map((n) => n.title),
	};
}
