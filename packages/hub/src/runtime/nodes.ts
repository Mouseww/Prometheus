import { isUniqueViolation, toIso } from "../db/db.ts";
import { badRequest, conflict, forbidden, notFound, validationError } from "../errors.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "../permissions.ts";
import { can } from "../permissions.ts";
import type { AuditService } from "../services/audit.ts";
import { type ServiceDeps, scopeOf } from "../services/common.ts";
import { parseDockerUrl } from "./docker-api.ts";
import type { ExecutorNode } from "./driver.ts";

export interface NodeInput {
	name: string;
	dockerUrl: string;
	tlsDir?: string | null | undefined;
	cpuCapacity?: number | undefined;
	memCapacityMb?: number | undefined;
	status?: "active" | "draining" | "offline" | undefined;
}

export interface NodeView extends ExecutorNode {
	lastPingAt: string | null;
	createdAt: string;
	/** CPU and memory promised to tenants that are starting or running there. */
	allocatedCpu: number;
	allocatedMemMb: number;
	tenants: string[];
}

export type Placement = { kind: "local" } | { kind: "node"; node: ExecutorNode } | { kind: "exhausted" };

export interface NodesService {
	list(actor: Actor): Promise<NodeView[]>;
	create(actor: Actor, input: NodeInput): Promise<NodeView>;
	update(actor: Actor, id: string, input: Partial<NodeInput>): Promise<NodeView>;
	remove(actor: Actor, id: string): Promise<void>;
	/** Records a ping result (admin "check" button and the health timer). */
	ping(actor: Actor, id: string): Promise<{ ok: boolean }>;
	/** Capacity-aware placement: the active node with the most free memory that still fits the request; local Docker when no nodes exist. */
	place(request: { cpu: number; memMb: number }): Promise<Placement>;
	/** Looks a node up for a tenant that already runs on it (stop, stats). */
	get(id: string): Promise<ExecutorNode | undefined>;
}

interface NodeRow {
	id: string;
	name: string;
	docker_url: string;
	tls_dir: string | null;
	cpu_capacity: number | string;
	mem_capacity_mb: number;
	status: "active" | "draining" | "offline";
	last_ping_at: Date | string | null;
	created_at: Date | string;
}

interface UsageRow {
	node_id: string;
	user_id: string;
	cpu: number | string;
	mem: number | string;
}

const COLUMNS = "id, name, docker_url, tls_dir, cpu_capacity, mem_capacity_mb, status, last_ping_at, created_at";

const toNode = (r: NodeRow): ExecutorNode => ({
	id: r.id,
	name: r.name,
	dockerUrl: r.docker_url,
	...(r.tls_dir ? { tlsDir: r.tls_dir } : {}),
	cpuCapacity: Number(r.cpu_capacity),
	memCapacityMb: r.mem_capacity_mb,
	status: r.status,
});

const isLoopbackHost = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "::1";

/** Rejects addresses the Hub cannot talk to safely: plain tcp to a remote engine would hand out root on that machine. */
export function validateNodeUrl(dockerUrl: string, tlsDir: string | null | undefined): void {
	let endpoint: ReturnType<typeof parseDockerUrl>;
	try {
		endpoint = parseDockerUrl(dockerUrl, tlsDir ?? undefined);
	} catch (err) {
		throw validationError(err instanceof Error ? err.message : "Docker 地址无效");
	}
	if (endpoint.kind === "tcp" && !endpoint.tls && !isLoopbackHost(endpoint.host)) throw validationError("远程 Docker 节点必须启用 TLS（填写 tlsDir，目录内含 ca.pem、cert.pem、key.pem）");
}

export interface NodesDeps extends ServiceDeps {
	audit: AuditService;
	defaults: { cpu: number; memMb: number };
	/** Tests and the real client probe an engine here. */
	pingNode: (node: ExecutorNode) => Promise<boolean>;
}

export function createNodesService(deps: NodesDeps): NodesService {
	const requireOperator = (actor: Actor): void => {
		if (!can(actor, "platform.manage")) throw forbidden();
	};

	const usage = async (q: { query: <T>(sql: string, p?: unknown[]) => Promise<T[]> }): Promise<UsageRow[]> =>
		q.query<UsageRow>(
			`SELECT node_id, user_id, coalesce(cpu_limit, $1::numeric) AS cpu, coalesce(mem_limit_mb, $2::int) AS mem
			 FROM tenant_runtimes WHERE node_id IS NOT NULL AND status IN ('starting', 'running')`,
			[deps.defaults.cpu, deps.defaults.memMb],
		);

	const view = (row: NodeRow, used: UsageRow[]): NodeView => {
		const mine = used.filter((u) => u.node_id === row.id);
		return {
			...toNode(row),
			lastPingAt: toIso(row.last_ping_at),
			createdAt: toIso(row.created_at) as string,
			allocatedCpu: mine.reduce((s, u) => s + Number(u.cpu), 0),
			allocatedMemMb: mine.reduce((s, u) => s + Number(u.mem), 0),
			tenants: mine.map((u) => u.user_id),
		};
	};

	const load = async (id: string): Promise<NodeView> => {
		const [row, used] = await deps.db.tx({ system: true }, async (q) => [(await q.query<NodeRow>(`SELECT ${COLUMNS} FROM executor_nodes WHERE id = $1`, [id]))[0], await usage(q)] as const);
		if (!row) throw notFound("执行节点不存在");
		return view(row, used);
	};

	return {
		async list(actor) {
			requireOperator(actor);
			const [rows, used] = await deps.db.tx(scopeOf(actor), async (q) => [await q.query<NodeRow>(`SELECT ${COLUMNS} FROM executor_nodes ORDER BY name`), await usage(q)] as const);
			return rows.map((r) => view(r, used));
		},

		async create(actor, input) {
			requireOperator(actor);
			validateNodeUrl(input.dockerUrl, input.tlsDir);
			const id = ulid();
			try {
				await deps.db.tx(scopeOf(actor), async (q) => {
					await q.query(
						`INSERT INTO executor_nodes (id, name, docker_url, tls_dir, cpu_capacity, mem_capacity_mb, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
						[id, input.name, input.dockerUrl, input.tlsDir ?? null, input.cpuCapacity ?? 4, input.memCapacityMb ?? 8192, input.status ?? "active"],
					);
					await deps.audit.write(q, { actorId: actor.userId, action: "node.create", targetType: "executor_node", targetId: id, detail: { name: input.name } });
				});
			} catch (err) {
				if (isUniqueViolation(err)) throw conflict("已有同名执行节点", "nodeNameTaken");
				throw err;
			}
			return load(id);
		},

		async update(actor, id, input) {
			requireOperator(actor);
			const current = await load(id);
			const dockerUrl = input.dockerUrl ?? current.dockerUrl;
			const tlsDir = input.tlsDir === undefined ? (current.tlsDir ?? null) : input.tlsDir;
			validateNodeUrl(dockerUrl, tlsDir);
			try {
				await deps.db.tx(scopeOf(actor), async (q) => {
					await q.query(
						`UPDATE executor_nodes SET name = $2, docker_url = $3, tls_dir = $4, cpu_capacity = $5, mem_capacity_mb = $6, status = $7 WHERE id = $1`,
						[id, input.name ?? current.name, dockerUrl, tlsDir, input.cpuCapacity ?? current.cpuCapacity, input.memCapacityMb ?? current.memCapacityMb, input.status ?? current.status],
					);
					await deps.audit.write(q, { actorId: actor.userId, action: "node.update", targetType: "executor_node", targetId: id, detail: { ...input } });
				});
			} catch (err) {
				if (isUniqueViolation(err)) throw conflict("已有同名执行节点", "nodeNameTaken");
				throw err;
			}
			return load(id);
		},

		async remove(actor, id) {
			requireOperator(actor);
			const node = await load(id);
			if (node.tenants.length > 0) throw badRequest("节点上还有运行中的租户，请先标记 draining 并等待其停止", "nodeBusy");
			await deps.db.tx(scopeOf(actor), async (q) => {
				await q.query("DELETE FROM executor_nodes WHERE id = $1", [id]);
				await deps.audit.write(q, { actorId: actor.userId, action: "node.delete", targetType: "executor_node", targetId: id, detail: { name: node.name } });
			});
		},

		async ping(actor, id) {
			requireOperator(actor);
			const node = await load(id);
			const ok = await deps.pingNode(node).catch(() => false);
			if (ok) await deps.db.tx({ system: true }, (q) => q.query("UPDATE executor_nodes SET last_ping_at = $2 WHERE id = $1", [id, new Date(deps.now()).toISOString()]));
			return { ok };
		},

		async place(request) {
			return deps.db.tx({ system: true }, async (q) => {
				const rows = await q.query<NodeRow>(`SELECT ${COLUMNS} FROM executor_nodes`);
				if (rows.length === 0) return { kind: "local" } as const;
				const used = await usage(q);
				const fits = rows
					.filter((r) => r.status === "active")
					.map((r) => {
						const v = view(r, used);
						return { node: toNode(r), freeMem: v.memCapacityMb - v.allocatedMemMb, freeCpu: v.cpuCapacity - v.allocatedCpu };
					})
					.filter((c) => c.freeMem >= request.memMb && c.freeCpu >= request.cpu)
					.sort((a, b) => b.freeMem - a.freeMem);
				const best = fits[0];
				return best ? ({ kind: "node", node: best.node } as const) : ({ kind: "exhausted" } as const);
			});
		},

		async get(id) {
			const rows = await deps.db.tx({ system: true }, (q) => q.query<NodeRow>(`SELECT ${COLUMNS} FROM executor_nodes WHERE id = $1`, [id]));
			return rows[0] ? toNode(rows[0]) : undefined;
		},
	};
}
