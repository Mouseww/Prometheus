import Value from "typebox/value";
import { REFRESH_SKEW_MS, refreshToken } from "./oauth.ts";
import { providerById } from "./providers/index.ts";
import type { Access, ConnectionRecord, ConnectorProvider, Credentials, Operation, OperationContext, Policy } from "./types.ts";
import type { Vault } from "./vault.ts";

const MAX_RESULT_CHARS = 24_000;

export class ConnectorError extends Error {}

export function authMethodOf(provider: ConnectorProvider, kind: ConnectionRecord["authKind"]) {
	const method = provider.auth.find((a) => a.kind === kind);
	if (!method) throw new ConnectorError(`${provider.name} 不支持认证方式 ${kind}`);
	return method;
}

/** Cap what goes back into the model's context; the tail is replaced by a note so the model knows. */
export function renderResult(value: unknown, max = MAX_RESULT_CHARS): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
	if (text === undefined) return "(无返回内容)";
	return text.length > max ? `${text.slice(0, max)}\n…[已截断，原长 ${text.length} 字符；请缩小查询范围]` : text;
}

export interface CallInput {
	connection: string;
	operation: string;
	params: Record<string, unknown>;
	signal?: AbortSignal;
	/** Ask the user to approve a write. Undefined when nobody is present. */
	confirm?: (message: string) => Promise<boolean>;
}

/** Decision about whether `access` may run under `policy`. `ask` means a human must approve. */
export function decide(policy: Policy, access: Access): "allow" | "deny" | "ask" {
	if (access === "read" || policy === "allow") return "allow";
	return policy === "read-only" ? "deny" : "ask";
}

export function createService(vault: Vault) {
	const refreshing = new Map<string, Promise<void>>();

	async function ensureFresh(record: ConnectionRecord): Promise<ConnectionRecord> {
		if (record.expiresAt === undefined || record.expiresAt - REFRESH_SKEW_MS > Date.now()) return record;
		// Concurrent calls share one refresh: refresh tokens are often single-use.
		let job = refreshing.get(record.id);
		if (!job) {
			job = (async () => {
				const secrets = await vault.secrets(record);
				if (!secrets.refreshToken || !secrets.clientId) throw new ConnectorError("授权已过期，且无法自动刷新，请重新授权该连接");
				const provider = providerById(record.provider);
				if (!provider) throw new ConnectorError(`未知提供方：${record.provider}`);
				const next = await refreshToken(authMethodOf(provider, record.authKind), record.config, { clientId: secrets.clientId, clientSecret: secrets.clientSecret, refreshToken: secrets.refreshToken }).catch((err: unknown) => {
					throw new ConnectorError(`连接「${record.label}」的授权已过期且自动刷新失败，请在 设置 → 连接器 中删除后重新授权（${err instanceof Error ? err.message.slice(0, 200) : String(err)}）`);
				});
				await vault.updateSecrets(record.id, (s) => ({ ...s, token: next.accessToken, refreshToken: next.refreshToken ?? s.refreshToken }), next.expiresAt);
			})().finally(() => refreshing.delete(record.id));
			refreshing.set(record.id, job);
		}
		await job;
		return (await vault.get(record.id)) ?? record;
	}

	async function credentialsFor(record: ConnectionRecord): Promise<Credentials> {
		const fresh = await ensureFresh(record);
		const s = await vault.secrets(fresh);
		return { config: fresh.config, token: s.token, secrets: s.values };
	}

	async function context(record: ConnectionRecord, signal?: AbortSignal): Promise<OperationContext> {
		return { credentials: await credentialsFor(record), signal, policy: record.policy };
	}

	function findOperation(provider: ConnectorProvider, name: string): Operation {
		const op = provider.operations.find((o) => o.name === name);
		if (!op) throw new ConnectorError(`${provider.name} 没有操作 ${name}。可用：${provider.operations.map((o) => o.name).join(", ")}`);
		return op;
	}

	return {
		credentialsFor,
		context,

		async call(input: CallInput): Promise<unknown> {
			const record = await vault.get(input.connection);
			if (!record) throw new ConnectorError(`连接不存在：${input.connection}`);
			const provider = providerById(record.provider);
			if (!provider) throw new ConnectorError(`未知提供方：${record.provider}`);
			const op = findOperation(provider, input.operation);

			if (!Value.Check(op.params, input.params)) {
				const first = [...Value.Errors(op.params, input.params)][0];
				throw new ConnectorError(`参数无效：${first ? `${first.instancePath || "/"} ${first.message}` : "格式错误"}`);
			}

			const verdict = decide(record.policy, op.access);
			if (verdict === "deny") throw new ConnectorError(`连接「${record.label}」是只读的，不能执行写操作 ${op.name}`);
			if (verdict === "ask") {
				if (!input.confirm) throw new ConnectorError(`写操作 ${op.name} 需要用户确认，但当前没有可交互的界面，已拒绝`);
				const summary = `${provider.name} · ${record.label}\n操作：${op.name}\n参数：${renderResult(input.params, 1200)}`;
				if (!(await input.confirm(summary))) throw new ConnectorError("用户拒绝了该写操作");
			}

			return op.run(input.params, await context(record, input.signal));
		},
	};
}

export type ConnectorService = ReturnType<typeof createService>;
