import { describe, expect, it } from "vitest";
import { createApiMethods, type Requester } from "../src/team/api.ts";
import {
	canOpenWorkbench,
	canStartRuntime,
	canStopRuntime,
	EMPTY_NODE_FORM,
	formatMem,
	isTransitional,
	limitsFromForm,
	loadTone,
	nodeInputFromForm,
	nodeLoad,
	percent,
	placementOrder,
	sortRuntimes,
	statusTone,
	userLabel,
} from "../src/team/logic/runtime.ts";
import type { NodeView, RuntimeView } from "../src/team/types.ts";

interface Seen {
	method: string;
	path: string;
	body?: unknown;
}

function recorder() {
	const seen: Seen[] = [];
	const requester: Requester = {
		async request<T>(method: string, path: string, body?: unknown): Promise<T> {
			seen.push(body === undefined ? { method, path } : { method, path, body });
			return undefined as T;
		},
	};
	return { seen, api: createApiMethods(requester) };
}

const node = (id: string, patch: Partial<NodeView> = {}): NodeView => ({
	id,
	name: id,
	dockerUrl: "tcp://x:2376",
	cpuCapacity: 8,
	memCapacityMb: 16384,
	status: "active",
	lastPingAt: null,
	createdAt: "2026-01-01T00:00:00Z",
	allocatedCpu: 0,
	allocatedMemMb: 0,
	tenants: [],
	...patch,
});

const rt = (userId: string, patch: Partial<RuntimeView> = {}): RuntimeView => ({
	userId,
	orgId: null,
	driver: "docker",
	nodeId: null,
	status: "running",
	port: 1,
	containerId: null,
	pid: null,
	startedAt: null,
	lastSeenAt: null,
	cpuLimit: null,
	memLimitMb: null,
	lastError: null,
	activeConnections: 0,
	restartRequired: false,
	...patch,
});

describe("hybrid execution and runtime API methods", () => {
	it("builds the exec and handoff requests", async () => {
		const { seen, api } = recorder();
		await api.getSessionExec("s 1");
		await api.setSessionExecMode("s1", "team-first");
		await api.handoffSession("s1", "team");
		await api.handoffSession("s1", "local", true);
		expect(seen).toEqual([
			{ method: "GET", path: "/api/sessions/s%201/exec" },
			{ method: "PATCH", path: "/api/sessions/s1/exec", body: { mode: "team-first" } },
			{ method: "POST", path: "/api/sessions/s1/handoff", body: { to: "team" } },
			{ method: "POST", path: "/api/sessions/s1/handoff", body: { to: "local", force: true } },
		]);
	});

	it("builds the runtime and node requests", async () => {
		const { seen, api } = recorder();
		await api.getMyRuntime();
		await api.startMyRuntime();
		await api.listRuntimes();
		await api.stopRuntime("u/1");
		await api.setRuntimeLimits("u1", { cpuLimit: 2, memLimitMb: null });
		await api.listNodes();
		await api.createNode({ name: "n1", dockerUrl: "tcp://h:2376", memCapacityMb: 8192 });
		await api.updateNode("n1", { status: "active" });
		await api.drainNode("n1");
		await api.pingNode("n1");
		await api.deleteNode("n 1");
		expect(seen).toEqual([
			{ method: "GET", path: "/api/runtime" },
			{ method: "POST", path: "/api/runtime/start" },
			{ method: "GET", path: "/api/admin/runtimes" },
			{ method: "POST", path: "/api/admin/runtimes/u%2F1/stop" },
			{ method: "PUT", path: "/api/admin/runtimes/u1/limits", body: { cpuLimit: 2, memLimitMb: null } },
			{ method: "GET", path: "/api/admin/nodes" },
			{ method: "POST", path: "/api/admin/nodes", body: { name: "n1", dockerUrl: "tcp://h:2376", memCapacityMb: 8192 } },
			{ method: "PUT", path: "/api/admin/nodes/n1", body: { status: "active" } },
			{ method: "POST", path: "/api/admin/nodes/n1/drain" },
			{ method: "POST", path: "/api/admin/nodes/n1/ping" },
			{ method: "DELETE", path: "/api/admin/nodes/n%201" },
		]);
	});
});

describe("runtime state helpers", () => {
	it("decides what each state allows", () => {
		expect(isTransitional("starting")).toBe(true);
		expect(isTransitional("stopping")).toBe(true);
		expect(isTransitional("running")).toBe(false);
		expect(canOpenWorkbench("running")).toBe(true);
		expect(canOpenWorkbench("starting")).toBe(false);
		expect(canStartRuntime("stopped")).toBe(true);
		expect(canStartRuntime("failed")).toBe(true);
		expect(canStartRuntime("running")).toBe(false);
		expect(canStopRuntime("running")).toBe(true);
		expect(canStopRuntime("starting")).toBe(true);
		expect(canStopRuntime("stopped")).toBe(false);
		expect(statusTone("running")).toBe("moss");
		expect(statusTone("failed")).toBe("rose");
		expect(statusTone("stopping")).toBe("sky");
		expect(statusTone("stopped")).toBe("muted");
	});

	it("formats memory and percentages", () => {
		expect(formatMem(512)).toBe("512 MB");
		expect(formatMem(2048)).toBe("2 GB");
		expect(formatMem(1536)).toBe("1.5 GB");
		expect(formatMem(-1)).toBe("-");
		expect(percent(1, 4)).toBe(25);
		expect(percent(9, 4)).toBe(100);
		expect(percent(1, 0)).toBe(0);
		expect(loadTone(10)).toBe("moss");
		expect(loadTone(75)).toBe("ember");
		expect(loadTone(95)).toBe("rose");
	});

	it("computes node load and the placement order the Hub uses", () => {
		const a = node("a", { allocatedCpu: 4, allocatedMemMb: 8192 });
		expect(nodeLoad(a)).toEqual({ cpuPct: 50, memPct: 50, freeMemMb: 8192 });
		const b = node("b", { allocatedMemMb: 1024 });
		const c = node("c", { status: "draining" });
		const d = node("d", { memCapacityMb: 65536 });
		expect(placementOrder([a, b, c, d]).map((n) => n.id)).toEqual(["d", "b", "a"]);
	});

	it("sorts runtimes by recent activity and labels users", () => {
		const items = [rt("u1", { lastSeenAt: "2026-01-01T00:00:00Z" }), rt("u2", { lastSeenAt: "2026-02-01T00:00:00Z" }), rt("u3")];
		expect(sortRuntimes(items).map((r) => r.userId)).toEqual(["u2", "u1", "u3"]);
		expect(userLabel("u1", { u1: "Ada" })).toBe("Ada");
		expect(userLabel("0123456789abcdef", {})).toBe("01234567");
	});
});

describe("node and limits forms", () => {
	it("accepts a minimal registration and trims it", () => {
		const r = nodeInputFromForm({ ...EMPTY_NODE_FORM, name: " n1 ", dockerUrl: " tcp://h:2376 " });
		expect(r).toEqual({ ok: true, input: { name: "n1", dockerUrl: "tcp://h:2376" } });
	});

	it("carries optional fields and rejects bad numbers with the field name", () => {
		expect(nodeInputFromForm({ name: "n", dockerUrl: "u", tlsDir: "/certs", cpuCapacity: "8", memCapacityMb: "16384" })).toEqual({ ok: true, input: { name: "n", dockerUrl: "u", tlsDir: "/certs", cpuCapacity: 8, memCapacityMb: 16384 } });
		expect(nodeInputFromForm({ ...EMPTY_NODE_FORM, dockerUrl: "u" })).toEqual({ ok: false, field: "name" });
		expect(nodeInputFromForm({ ...EMPTY_NODE_FORM, name: "n" })).toEqual({ ok: false, field: "dockerUrl" });
		expect(nodeInputFromForm({ name: "n", dockerUrl: "u", tlsDir: "", cpuCapacity: "0", memCapacityMb: "" })).toEqual({ ok: false, field: "cpuCapacity" });
		expect(nodeInputFromForm({ name: "n", dockerUrl: "u", tlsDir: "", cpuCapacity: "", memCapacityMb: "100" })).toEqual({ ok: false, field: "memCapacityMb" });
		expect(nodeInputFromForm({ name: "n", dockerUrl: "u", tlsDir: "", cpuCapacity: "", memCapacityMb: "512.5" })).toEqual({ ok: false, field: "memCapacityMb" });
	});

	it("turns empty limits into null and validates the rest", () => {
		expect(limitsFromForm("", "")).toEqual({ ok: true, cpuLimit: null, memLimitMb: null });
		expect(limitsFromForm("1.5", "2048")).toEqual({ ok: true, cpuLimit: 1.5, memLimitMb: 2048 });
		expect(limitsFromForm("0", "")).toEqual({ ok: false, field: "cpuLimit" });
		expect(limitsFromForm("", "32")).toEqual({ ok: false, field: "memLimitMb" });
		expect(limitsFromForm("abc", "")).toEqual({ ok: false, field: "cpuLimit" });
	});
});
