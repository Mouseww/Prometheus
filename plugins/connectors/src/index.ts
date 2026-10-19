import { randomBytes } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { definePlugin } from "@prometheus/plugin-sdk";
import { buildAuthorizeUrl, exchangeCode, pkcePair, pollDevice, startDevice, type TokenResult } from "./oauth.ts";
import { providerById, providers } from "./providers/index.ts";
import { authMethodOf, ConnectorError, createService, renderResult } from "./service.ts";
import { type AuthMethod, type ConnectionRecord, type ConnectorProvider, type FieldSpec, type Policy, type StoredSecrets, toView } from "./types.ts";
import { openVault } from "./vault.ts";

const CALLBACK_PATH = "/plugins/connectors/oauth/callback";
const FLOW_TTL_MS = 10 * 60_000;
const MAX_FLOWS = 20;
const POLICIES: Policy[] = ["read-only", "confirm", "allow"];

interface Flow {
	provider: ConnectorProvider;
	method: Extract<AuthMethod, { kind: "oauth-code" | "oauth-device" }>;
	label: string;
	policy: Policy;
	config: Record<string, string>;
	clientId: string;
	clientSecret?: string;
	createdAt: number;
	// code flow
	verifier?: string;
	redirectUri?: string;
	// device flow
	deviceCode?: string;
	intervalSec?: number;
	/** Result visible to the poller. */
	result?: { status: "done"; connection: string } | { status: "error"; error: string };
}

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function requireProvider(id: unknown): ConnectorProvider {
	const p = providerById(str(id, 64));
	if (!p) throw new ConnectorError(`未知提供方：${str(id, 64)}`);
	return p;
}

function requirePolicy(v: unknown): Policy {
	return POLICIES.includes(v as Policy) ? (v as Policy) : "confirm";
}

function fieldsFor(provider: ConnectorProvider, kind: string): FieldSpec[] {
	return provider.fields[kind as keyof ConnectorProvider["fields"]] ?? [];
}

/** Fields the UI shows for an auth kind; bare token auth always gets a token input. */
export function formFields(provider: ConnectorProvider, kind: string): FieldSpec[] {
	const specs = fieldsFor(provider, kind);
	if (kind === "token" && !specs.some((f) => f.key === "token")) return [{ key: "token", label: "访问令牌", secret: true, required: true }, ...specs];
	return specs;
}

/** Split submitted form values into plain config and encrypted secrets, enforcing required fields. */
export function splitFields(specs: FieldSpec[], input: Record<string, unknown>): { config: Record<string, string>; secrets: StoredSecrets } {
	const config: Record<string, string> = {};
	const secrets: StoredSecrets = { values: {} };
	for (const f of specs) {
		const v = str(input[f.key], 4000);
		if (!v) {
			if (f.required) throw new ConnectorError(`请填写：${f.label}`);
			continue;
		}
		if (f.key === "token") secrets.token = v;
		else if (f.secret) secrets.values[f.key] = v;
		else config[f.key] = v;
	}
	return { config, secrets };
}

function catalog() {
	return providers.map((p) => ({
		id: p.id,
		name: p.name,
		category: p.category,
		description: p.description,
		auth: p.auth.map((a) => ({ kind: a.kind, help: a.help, label: "label" in a ? a.label : undefined, scopes: "scopes" in a ? a.scopes : undefined })),
		builtin: Object.keys(p.builtinClientIds ?? {}),
		fields: Object.fromEntries([...p.auth.map((a): [string, FieldSpec[]] => [a.kind, formFields(p, a.kind)]), ["oauth-app", fieldsFor(p, "oauth-app")]]),
		operations: p.operations.map((o) => ({ name: o.name, description: o.description, access: o.access })),
	}));
}

export default definePlugin({
	name: "connectors",
	version: "0.1.0",
	async setup(ctx) {
		const vault = await openVault(ctx.dataDir);
		const service = createService(vault);
		const flows = new Map<string, Flow>();

		const prune = () => {
			const now = Date.now();
			for (const [k, f] of flows) if (now - f.createdAt > FLOW_TTL_MS) flows.delete(k);
		};

		const newFlow = (flow: Flow): string => {
			prune();
			if (flows.size >= MAX_FLOWS) throw new ConnectorError("进行中的授权过多，请稍后再试");
			const id = randomBytes(24).toString("base64url");
			flows.set(id, flow);
			return id;
		};

		/** Verify the credentials against the provider before anything is stored. */
		async function finish(flow: Flow, token: TokenResult): Promise<ConnectionRecord> {
			const secrets: StoredSecrets = { token: token.accessToken, refreshToken: token.refreshToken, clientId: flow.clientId, clientSecret: flow.clientSecret, values: {} };
			const account = await flow.provider.test({ credentials: { config: flow.config, token: token.accessToken, secrets: {} }, policy: flow.policy });
			const record = await vault.add({ provider: flow.provider.id, label: flow.label, authKind: flow.method.kind, policy: flow.policy, config: flow.config, expiresAt: token.expiresAt, account, secrets });
			ctx.notifyChanged();
			return record;
		}

		// ---------- RPC for the settings UI ----------

		ctx.rpc("providers", () => catalog());
		ctx.rpc("list", async () => (await vault.list()).map(toView));

		ctx.rpc("connect", async (params) => {
			const provider = requireProvider(params.provider);
			const method = authMethodOf(provider, str(params.authKind, 32) as AuthMethod["kind"]);
			if (method.kind === "oauth-code" || method.kind === "oauth-device") throw new ConnectorError("OAuth 方式请使用 oauthStart");
			const input = (params.values ?? {}) as Record<string, unknown>;
			const { config, secrets } = splitFields(formFields(provider, method.kind), input);
			const policy = requirePolicy(params.policy);
			if (method.kind === "connection-string" && !secrets.values.connection) throw new ConnectorError("缺少连接串");
			const account = await provider.test({ credentials: { config, token: secrets.token, secrets: secrets.values }, policy });
			const record = await vault.add({ provider: provider.id, label: str(params.label, 80) || `${provider.name} (${account})`, authKind: method.kind, policy, config, account, secrets });
			ctx.notifyChanged();
			await ctx.reloadSessions();
			return toView(record);
		});

		ctx.rpc("oauthStart", async (params) => {
			const provider = requireProvider(params.provider);
			const method = authMethodOf(provider, str(params.authKind, 32) as AuthMethod["kind"]);
			if (method.kind !== "oauth-code" && method.kind !== "oauth-device") throw new ConnectorError("该认证方式不是 OAuth");
			const input = (params.values ?? {}) as Record<string, unknown>;
			let clientId = str(input.clientId, 300);
			let clientSecret = str(input.clientSecret, 500) || undefined;
			if (!clientId) {
				// Same OAuth app as an earlier connection of this service: no need to type it again.
				for (const r of await vault.list()) {
					if (r.provider !== provider.id) continue;
					const prev = await vault.secrets(r).catch(() => undefined);
					if (prev?.clientId) {
						clientId = prev.clientId;
						clientSecret = prev.clientSecret;
						break;
					}
				}
			}
			if (!clientId) clientId = provider.builtinClientIds?.[method.kind] ?? "";
			if (!clientId) throw new ConnectorError("请填写 Client ID");
			const config: Record<string, string> = {};
			for (const f of fieldsFor(provider, "oauth-app")) {
				const v = str(input[f.key], 300);
				if (f.key !== "clientId" && f.key !== "clientSecret" && v) config[f.key] = v;
			}
			// Tenant defaults keep the common case to one field.
			if (provider.id === "microsoft") config.tenant ||= "organizations";
			const base = { provider, method, label: str(params.label, 80) || provider.name, policy: requirePolicy(params.policy), config, clientId, clientSecret, createdAt: Date.now() };

			if (method.kind === "oauth-device") {
				const d = await startDevice(method, config, clientId);
				const flowId = newFlow({ ...base, deviceCode: d.deviceCode, intervalSec: d.intervalSec });
				return { flowId, kind: "device", userCode: d.userCode, verificationUri: d.verificationUri, intervalSec: d.intervalSec, expiresAt: d.expiresAt };
			}

			const redirectUri = str(params.redirectUri, 300);
			if (!redirectUri.endsWith(CALLBACK_PATH)) throw new ConnectorError("回调地址无效");
			const { verifier, challenge } = pkcePair();
			const flowId = newFlow({ ...base, verifier, redirectUri });
			return { flowId, kind: "code", url: buildAuthorizeUrl(method, config, { clientId, redirectUri, state: flowId, challenge }) };
		});

		ctx.rpc("oauthPoll", async (params) => {
			const flowId = str(params.flowId, 100);
			const flow = flows.get(flowId);
			if (!flow) return { status: "error", error: "授权已过期，请重新开始" };
			if (flow.result) {
				flows.delete(flowId);
				return flow.result;
			}
			if (flow.method.kind === "oauth-device" && flow.deviceCode) {
				try {
					const r = await pollDevice(flow.method, flow.config, flow.clientId, flow.deviceCode);
					if (r.status === "pending") return { status: "pending", slowDown: r.slowDown };
					const record = await finish(flow, r.token);
					flows.delete(flowId);
					await ctx.reloadSessions();
					return { status: "done", connection: record.id };
				} catch (err) {
					flows.delete(flowId);
					return { status: "error", error: err instanceof Error ? err.message : String(err) };
				}
			}
			return { status: "pending" };
		});

		ctx.rpc("update", async (params) => {
			const id = str(params.id, 40);
			if (!(await vault.get(id))) throw new ConnectorError("连接不存在");
			await vault.patch(id, { ...(params.label !== undefined ? { label: str(params.label, 80) || "未命名" } : {}), ...(params.policy !== undefined ? { policy: requirePolicy(params.policy) } : {}) });
			ctx.notifyChanged();
			return null;
		});

		ctx.rpc("remove", async (params) => {
			await vault.remove(str(params.id, 40));
			ctx.notifyChanged();
			await ctx.reloadSessions();
			return null;
		});

		ctx.rpc("test", async (params) => {
			const record = await vault.get(str(params.id, 40));
			if (!record) throw new ConnectorError("连接不存在");
			const provider = requireProvider(record.provider);
			try {
				const account = await provider.test(await service.context(record));
				await vault.patch(record.id, { account });
				return { ok: true, account };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		});

		// ---------- OAuth redirect target (authorization-code flow) ----------

		ctx.route("GET", CALLBACK_PATH, async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const state = url.searchParams.get("state") ?? "";
			const flow = flows.get(state);
			const page = (title: string, body: string, status = 200) => {
				res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
				res.end(`<!doctype html><meta charset="utf-8"><title>${html(title)}</title><body style="font:16px system-ui;padding:3rem;text-align:center"><h2>${html(title)}</h2><p>${html(body)}</p>`);
			};
			if (!flow || flow.method.kind !== "oauth-code" || !flow.verifier || !flow.redirectUri) return page("授权失败", "授权请求不存在或已过期，请回到 Prometheus 重新开始。", 400);
			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			try {
				if (error || !code) throw new Error(url.searchParams.get("error_description") ?? error ?? "未收到授权码");
				const token = await exchangeCode(flow.method, flow.config, { clientId: flow.clientId, clientSecret: flow.clientSecret, code, redirectUri: flow.redirectUri, verifier: flow.verifier });
				const record = await finish(flow, token);
				flow.result = { status: "done", connection: record.id };
				await ctx.reloadSessions();
				page("授权成功", "现在可以关闭此页面，回到 Prometheus。");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				flow.result = { status: "error", error: message };
				page("授权失败", message, 400);
			}
		});

		// ---------- Agent tools ----------

		ctx.extension((pi) => {
			const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

			pi.registerTool({
				name: "connector_list",
				label: "已连接服务",
				description: "List third-party services the user has connected (GitHub, Jira, Outlook, databases, ...). Shows connection ids and whether writes are allowed. Never shows credentials.",
				promptSnippet: "connector_list: see which third-party services are connected",
				parameters: Type.Object({}),
				async execute() {
					const list = await vault.list();
					if (!list.length) return text("No connections. The user can add one in Settings → Connectors.");
					return text(list.map((c) => `${c.id}  ${c.provider}  "${c.label}"  account=${c.account ?? "?"}  writes=${c.policy}`).join("\n"));
				},
			});

			pi.registerTool({
				name: "connector_describe",
				label: "查看连接器操作",
				description: "Describe the operations (and their JSON parameter schemas) a connected provider supports. Call this before connector_call with an unfamiliar provider.",
				parameters: Type.Object({ provider: Type.String({ description: "github | atlassian | bitbucket | microsoft | database" }) }),
				async execute(_id, params) {
					const p = providerById(params.provider);
					if (!p) throw new Error(`Unknown provider ${params.provider}. Known: ${providers.map((x) => x.id).join(", ")}`);
					return text(renderResult(p.operations.map((o) => ({ name: o.name, access: o.access, description: o.description, params: o.params }))));
				},
			});

			pi.registerTool({
				name: "connector_call",
				label: "调用第三方服务",
				description:
					"Run an operation on a connected third-party service. Use connector_list for the connection id and connector_describe for operation names and params. Write operations may require user confirmation or be refused by the connection's policy; do not retry a refused write.",
				promptSnippet: "connector_call: act on connected services (GitHub, Jira, Outlook, Teams, databases)",
				parameters: Type.Object({
					connection: Type.String({ description: "Connection id from connector_list" }),
					operation: Type.String(),
					params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
				}),
				async execute(_id, params, signal, _update, toolCtx) {
					const result = await service.call({
						connection: params.connection,
						operation: params.operation,
						params: params.params ?? {},
						signal,
						confirm: toolCtx.hasUI ? (message) => toolCtx.ui.confirm("允许写入第三方服务？", message) : undefined,
					});
					return text(renderResult(result));
				},
			});

			pi.on("before_agent_start", async (event) => {
				const list = await vault.list();
				if (!list.length) return;
				const lines = list.map((c) => `- ${c.id}: ${c.provider} "${c.label}" (writes: ${c.policy})`).join("\n");
				event.systemPromptOptions.sections.connectors = `# Connected services\nThe user has connected these third-party services. Use connector_describe / connector_call; never ask the user to paste credentials.\n${lines}`;
			});
		});
	},
});
