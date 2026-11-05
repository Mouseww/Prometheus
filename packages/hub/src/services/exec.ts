import { conflict, forbidden, HubError, notFound } from "../errors.ts";
import { LOG_PREFIX } from "../log.ts";
import type { Actor } from "../permissions.ts";
import type { CommandOutcome, WsGateway } from "../ws.ts";
import { type ServiceDeps, scopeOf } from "./common.ts";
import type { ConnKind } from "./hands.ts";
import type { Realtime } from "./realtime.ts";

export type ExecLocation = "local" | "team";
export type ExecMode = "local-first" | "team-first";

export interface ExecState {
	sessionId: string;
	location: ExecLocation;
	mode: ExecMode;
	/** Id of the session inside the owner's tenant instance (set once the session has been handed to the team side). */
	tenantSessionId: string | null;
}

export interface ExecService {
	state(actor: Actor, sessionId: string): Promise<ExecState>;
	setMode(actor: Actor, sessionId: string, mode: ExecMode): Promise<ExecState>;
	/** Moves the session's brain to the other side (spec 6). Resolves with the new state once the target has imported it. */
	handoff(actor: Actor, sessionId: string, to: ExecLocation, opts?: { force?: boolean }): Promise<ExecState>;
}

export interface ExecDeps extends ServiceDeps {
	gateway: Pick<WsGateway, "command" | "connectionCount">;
	realtime: Realtime;
	/** Throws 404 when the actor may not even see the session (so outsiders learn nothing about it). */
	canView?: (actor: Actor, sessionId: string) => Promise<unknown>;
	/** Starts the user's tenant instance; undefined when this Hub has no runtime (then a handoff to the team side is a 503). */
	ensureTenant?: (userId: string) => Promise<unknown>;
	/** How long a handoff to the team side waits for the freshly started tenant to connect (default 60 s). */
	tenantWaitMs?: number;
	/** Timeout of each command sent to a side (default 120 s: the source may wait for an agent turn and a snapshot barrier). */
	commandTimeoutMs?: number;
}

interface Row {
	id: string;
	workspace_id: string;
	owner_user_id: string;
	exec_location: ExecLocation;
	exec_mode: ExecMode;
	tenant_session_id: string | null;
	local_session_id: string;
	branch: string;
	title: string;
}

const COLUMNS = "id, workspace_id, owner_user_id, exec_location, exec_mode, tenant_session_id, local_session_id, branch, title";
const kindOf = (location: ExecLocation): ConnKind => (location === "team" ? "tenant" : "local");
const sideName = (location: ExecLocation): string => (location === "team" ? "团队 server" : "本机");

const toState = (r: Row): ExecState => ({ sessionId: r.id, location: r.exec_location, mode: r.exec_mode, tenantSessionId: r.tenant_session_id });

export function createExecService(deps: ExecDeps): ExecService {
	const busy = new Set<string>();
	const commandTimeout = deps.commandTimeoutMs ?? 120_000;

	/** The caller's own session; anyone else who can see it gets a 403, outsiders a 404. */
	const loadOwned = async (actor: Actor, sessionId: string): Promise<Row> => {
		const rows = await deps.db.tx(scopeOf(actor), (q) => q.query<Row>(`SELECT ${COLUMNS} FROM sessions WHERE id = $1`, [sessionId]));
		const row = rows[0];
		if (!row) throw notFound("会话不存在");
		await deps.canView?.(actor, sessionId);
		if (row.owner_user_id !== actor.userId) throw forbidden("只有会话所有者可以切换执行位置", "notOwner");
		return row;
	};

	const publish = (row: Row, state: ExecState): void => {
		const data = { kind: "session.exec", sessionId: row.id, workspaceId: row.workspace_id, location: state.location, mode: state.mode, tenantSessionId: state.tenantSessionId };
		deps.realtime.publish(`session:${row.id}`, data);
		deps.realtime.publish(`workspace:${row.workspace_id}`, data);
		deps.realtime.publishUser(row.owner_user_id, data);
	};

	const waitForTenant = async (userId: string): Promise<boolean> => {
		const end = Date.now() + (deps.tenantWaitMs ?? 60_000);
		while (deps.gateway.connectionCount(userId, "tenant") === 0) {
			if (Date.now() >= end) return false;
			await new Promise((r) => setTimeout(r, 100));
		}
		return true;
	};

	const preflight = async (userId: string, to: ExecLocation): Promise<void> => {
		if (to === "team") {
			if (!deps.ensureTenant) throw new HubError(503, "runtimeUnavailable", "这个 Hub 没有启用租户运行时，无法在团队 server 上执行");
			try {
				await deps.ensureTenant(userId);
			} catch (err) {
				if (err instanceof HubError) throw err;
				throw new HubError(503, "runtimeUnavailable", `无法启动你的团队 server 实例: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!(await waitForTenant(userId))) throw new HubError(503, "targetOffline", "你的团队 server 实例已启动但尚未连上 Hub，请稍后重试");
		} else if (deps.gateway.connectionCount(userId, "local") === 0) {
			throw new HubError(503, "targetOffline", "你的本机 server 当前没有连接 Hub，无法把会话移回本机");
		}
		const from: ExecLocation = to === "team" ? "local" : "team";
		if (deps.gateway.connectionCount(userId, kindOf(from)) === 0) throw new HubError(409, "sourceOffline", `${sideName(from)}当前不在线，无法导出会话`);
	};

	const run = async (userId: string, kind: ConnKind, cmd: string, params: Record<string, unknown>): Promise<unknown> => {
		const outcome: CommandOutcome = await deps.gateway.command(userId, kind, cmd, params, commandTimeout);
		switch (outcome.kind) {
			case "ok":
				return outcome.data;
			case "offline":
				throw new HubError(503, kind === "tenant" ? "targetOffline" : "sourceOffline", `${kind === "tenant" ? "团队 server" : "本机"}在移交过程中断开了连接`);
			case "timeout":
				throw new HubError(504, "handoffTimeout", `${kind === "tenant" ? "团队 server" : "本机"}没有在限定时间内完成 ${cmd}`);
			case "failed":
				if (outcome.code === "agentBusy") throw conflict(outcome.error ?? "会话的 Agent 仍在运行，请等待它结束或选择中断", "agentBusy");
				throw new HubError(502, "handoffFailed", outcome.error ?? `${cmd} 失败`);
		}
	};

	const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);

	return {
		async state(actor, sessionId) {
			return toState(await loadOwned(actor, sessionId));
		},

		async setMode(actor, sessionId, mode) {
			await loadOwned(actor, sessionId);
			const rows = await deps.db.tx(scopeOf(actor), (q) => q.query<Row>(`UPDATE sessions SET exec_mode = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [sessionId, mode]));
			const row = rows[0] as Row;
			const state = toState(row);
			publish(row, state);
			return state;
		},

		async handoff(actor, sessionId, to, opts = {}) {
			const row = await loadOwned(actor, sessionId);
			if (row.exec_location === to) throw conflict(`会话已经在${sideName(to)}执行`, "alreadyThere");
			if (busy.has(sessionId)) throw conflict("该会话正在移交中", "handoffInProgress");
			busy.add(sessionId);
			try {
				const from = row.exec_location;
				// A session that was started inside the tenant instance is registered with the tenant's own session id as its local id.
				const sourceSessionId = from === "local" ? row.local_session_id : (row.tenant_session_id ?? row.local_session_id);
				if (!sourceSessionId) throw conflict(`会话在${sideName(from)}没有对应的本地会话，无法移交`, "noSourceSession");
				await preflight(actor.userId, to);

				const common = { hubSessionId: row.id, from, to, branch: row.branch, title: row.title };
				const exported = (await run(actor.userId, kindOf(from), "handoff.export", { ...common, sessionId: sourceSessionId, force: opts.force === true })) as { snapshotCommit?: unknown; nextSeq?: unknown } | undefined;
				const snapshotCommit = asString(exported?.snapshotCommit);
				// The target continues the event numbering where the source stopped, or the Hub would drop its first events as duplicates.
				const nextSeq = typeof exported?.nextSeq === "number" && Number.isInteger(exported.nextSeq) && exported.nextSeq >= 0 ? exported.nextSeq : undefined;
				const imported = (await run(actor.userId, kindOf(to), "handoff.import", { ...common, snapshotCommit, nextSeq })) as { sessionId?: unknown; serverId?: unknown } | undefined;
				const targetSessionId = asString(imported?.sessionId);
				const targetServerId = asString(imported?.serverId) ?? null;
				if (!targetSessionId) throw new HubError(502, "handoffFailed", `${sideName(to)}没有返回导入后的会话 id`);

				const rows = await deps.db.tx(scopeOf(actor), (q) =>
					to === "team"
						? q.query<Row>(`UPDATE sessions SET exec_location = 'team', tenant_session_id = $2, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [sessionId, targetSessionId])
						: q.query<Row>(
								`UPDATE sessions SET exec_location = 'local', tenant_session_id = COALESCE(tenant_session_id, local_session_id), local_session_id = $2, server_id = COALESCE($3, server_id), updated_at = now()
								 WHERE id = $1 RETURNING ${COLUMNS}`,
								[sessionId, targetSessionId, targetServerId],
							),
				);
				const updated = rows[0] as Row;
				const state = toState(updated);
				// The source now only mirrors: mark it read-only. Failing here must not undo a handoff that already happened.
				void run(actor.userId, kindOf(from), "handoff.finish", { ...common, sessionId: sourceSessionId, activeSessionId: targetSessionId }).catch((err: unknown) => {
					deps.log.warn(`${LOG_PREFIX} 移交后标记源会话只读失败: ${err instanceof Error ? err.message : String(err)}`);
				});
				publish(updated, state);
				return state;
			} finally {
				busy.delete(sessionId);
			}
		},
	};
}
