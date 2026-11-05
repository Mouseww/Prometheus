// Pure helpers for the tenant runtime pages (workbench entry, Nodes, Runtimes).
import type { NodeInput, NodeView, RuntimeStatus, RuntimeView } from "../types.ts";

/** The runtime is changing state: poll until it settles. */
export const isTransitional = (status: RuntimeStatus): boolean => status === "starting" || status === "stopping";

/** The workbench can be opened only while the instance runs. */
export const canOpenWorkbench = (status: RuntimeStatus): boolean => status === "running";

/** Starting makes sense from a stopped or failed instance; the other states are already moving or done. */
export const canStartRuntime = (status: RuntimeStatus): boolean => status === "stopped" || status === "failed";

/** An admin can stop an instance that runs or is coming up. */
export const canStopRuntime = (status: RuntimeStatus): boolean => status === "running" || status === "starting";

export const statusTone = (status: RuntimeStatus): "moss" | "sky" | "rose" | "muted" => (status === "running" ? "moss" : status === "failed" ? "rose" : status === "starting" || status === "stopping" ? "sky" : "muted");

/** "512 MB", "1.5 GB". */
export function formatMem(mb: number): string {
	if (!Number.isFinite(mb) || mb < 0) return "-";
	if (mb < 1024) return `${Math.round(mb)} MB`;
	const gb = mb / 1024;
	return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** Whole percent of `used` in `total`, clamped to 0..100; 0 when the total is not positive. */
export function percent(used: number, total: number): number {
	if (!(total > 0) || !Number.isFinite(used)) return 0;
	return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

export interface NodeLoad {
	cpuPct: number;
	memPct: number;
	/** Free memory still promised to nobody. */
	freeMemMb: number;
}

export function nodeLoad(node: Pick<NodeView, "cpuCapacity" | "memCapacityMb" | "allocatedCpu" | "allocatedMemMb">): NodeLoad {
	return { cpuPct: percent(node.allocatedCpu, node.cpuCapacity), memPct: percent(node.allocatedMemMb, node.memCapacityMb), freeMemMb: Math.max(0, node.memCapacityMb - node.allocatedMemMb) };
}

/** Bar colour class by load: calm below 70 percent, warning up to 90, full beyond. */
export const loadTone = (pct: number): "moss" | "ember" | "rose" => (pct >= 90 ? "rose" : pct >= 70 ? "ember" : "moss");

/** Nodes that can still take a tenant, most free memory first (the order the Hub places by). */
export function placementOrder(nodes: readonly NodeView[]): NodeView[] {
	return nodes.filter((n) => n.status === "active").sort((a, b) => nodeLoad(b).freeMemMb - nodeLoad(a).freeMemMb);
}

export interface NodeForm {
	name: string;
	dockerUrl: string;
	tlsDir: string;
	cpuCapacity: string;
	memCapacityMb: string;
}

export const EMPTY_NODE_FORM: NodeForm = { name: "", dockerUrl: "", tlsDir: "", cpuCapacity: "", memCapacityMb: "" };

/** A registration the Hub would accept, or the first field that is wrong. */
export function nodeInputFromForm(form: NodeForm): { ok: true; input: NodeInput } | { ok: false; field: "name" | "dockerUrl" | "cpuCapacity" | "memCapacityMb" } {
	const name = form.name.trim();
	if (name === "" || name.length > 100) return { ok: false, field: "name" };
	const dockerUrl = form.dockerUrl.trim();
	if (dockerUrl === "" || dockerUrl.length > 500) return { ok: false, field: "dockerUrl" };
	const input: NodeInput = { name, dockerUrl };
	const tls = form.tlsDir.trim();
	if (tls) input.tlsDir = tls;
	if (form.cpuCapacity.trim() !== "") {
		const cpu = Number(form.cpuCapacity);
		if (!Number.isFinite(cpu) || cpu <= 0 || cpu > 4096) return { ok: false, field: "cpuCapacity" };
		input.cpuCapacity = cpu;
	}
	if (form.memCapacityMb.trim() !== "") {
		const mem = Number(form.memCapacityMb);
		if (!Number.isInteger(mem) || mem < 256 || mem > 100_000_000) return { ok: false, field: "memCapacityMb" };
		input.memCapacityMb = mem;
	}
	return { ok: true, input };
}

/** Runtimes newest activity first; never-seen instances last. */
export function sortRuntimes(items: readonly RuntimeView[]): RuntimeView[] {
	const at = (r: RuntimeView): number => (r.lastSeenAt ? Date.parse(r.lastSeenAt) || 0 : 0);
	return [...items].sort((a, b) => at(b) - at(a) || a.userId.localeCompare(b.userId));
}

/** Display name for a user id: the user's name when known, else the id cut to eight characters. */
export const userLabel = (userId: string, names: Readonly<Record<string, string>>): string => names[userId] ?? userId.slice(0, 8);

/** Limits typed into the dialog: empty clears the limit (null), anything else must be a positive number. */
export function limitsFromForm(cpu: string, mem: string): { ok: true; cpuLimit: number | null; memLimitMb: number | null } | { ok: false; field: "cpuLimit" | "memLimitMb" } {
	let cpuLimit: number | null = null;
	let memLimitMb: number | null = null;
	if (cpu.trim() !== "") {
		cpuLimit = Number(cpu);
		if (!Number.isFinite(cpuLimit) || cpuLimit <= 0 || cpuLimit > 256) return { ok: false, field: "cpuLimit" };
	}
	if (mem.trim() !== "") {
		memLimitMb = Number(mem);
		if (!Number.isInteger(memLimitMb) || memLimitMb < 64 || memLimitMb > 10_000_000) return { ok: false, field: "memLimitMb" };
	}
	return { ok: true, cpuLimit, memLimitMb };
}
