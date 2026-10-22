/**
 * The plugin entry point.
 *
 * Two independent features share one rule engine and one panel:
 *  - **隐私保护**: replaces secrets in outbound provider requests with placeholders and restores
 *    them in the reply, using PI's `before_provider_request` hook.
 *  - **出口代理**: a local relay that forwards to the real upstream through a proxy, so the
 *    request leaves from a different IP. Turning it on points the gateway at the relay.
 *
 * Neither touches Prometheus' own code: everything happens through extension hooks, RPC and routes.
 */
import { definePlugin, type RpcHandler } from "@prometheus/plugin-sdk";
import { ConfigFile, type VeilConfig } from "./config.ts";
import { RuleSet, builtinRules, validateRule, type Rule } from "./engine/rules.ts";
import { MappingStore } from "./engine/store.ts";
import { desensitizeJson, desensitizeString, parseJson } from "./engine/walk.ts";
import { VeilRelay } from "./proxy/relay.ts";
import { parseProxyUrl, type ProxySettings } from "./proxy/transport.ts";

/** What the native view needs to draw itself. Never includes secrets. */
export interface PanelState {
	config: {
		redaction: boolean;
		relay: boolean;
		relayPort: number;
		upstream: string;
		regionNeutral: boolean;
		acceptLanguage: string;
		mappingTtlDays: number;
		packs: { secrets: boolean; region: boolean };
		proxyKind: ProxySettings["kind"];
		proxyServer: string;
		proxyAuth: boolean;
		rules: Rule[];
		allowlist: string[];
	};
	relay: { running: boolean; baseUrl: string; port: number; error?: string };
	stats: { mappings: number; hits: number; lastTypes: string[] };
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

export default definePlugin({
	name: "veil",
	version: "0.1.0",
	optional: true,
	async setup(ctx) {
		const configFile = ConfigFile.in(ctx.dataDir);
		await configFile.load();

		const store = new MappingStore({
			path: `${ctx.dataDir}/mappings.json`,
			ttlDays: configFile.get().mappingTtlDays,
		});
		const loaded = await store.load();
		if (loaded.loaded > 0) ctx.log.info(`已载入 ${loaded.loaded} 条化名映射${loaded.evicted ? `，清理 ${loaded.evicted} 条过期/无效` : ""}`);

		// Rebuilt lazily so a rule edit in the panel applies to the next request without a restart.
		let ruleset = buildRuleSet(configFile.get());
		const rebuild = () => {
			ruleset = buildRuleSet(configFile.get());
		};

		const relay = new VeilRelay({
			host: "127.0.0.1",
			port: configFile.get().relayPort,
			rules: () => ruleset,
			store,
			proxy: () => configFile.get().proxy,
			acceptLanguage: () => configFile.get().acceptLanguage,
			regionNeutral: () => configFile.get().regionNeutral,
			bodyLimitBytes: () => 32 * 1024 * 1024,
			routes: () => configFile.get().routes,
			defaultUpstream: () => configFile.get().upstream,
			log: { info: (m) => ctx.log.info(m), warn: (m) => ctx.log.warn(m), error: (m) => ctx.log.error(m) },
		});

		const state = (): PanelState => {
			const cfg = configFile.get();
			const relayStatus = relay.status();
			return {
				config: {
					redaction: cfg.redaction,
					relay: cfg.relay,
					relayPort: cfg.relayPort,
					upstream: cfg.upstream,
					regionNeutral: cfg.regionNeutral,
					acceptLanguage: cfg.acceptLanguage,
					mappingTtlDays: cfg.mappingTtlDays,
					packs: cfg.packs,
					proxyKind: cfg.proxy.kind,
					proxyServer: cfg.proxy.server,
					proxyAuth: Boolean(cfg.proxy.username),
					rules: cfg.rules,
					allowlist: cfg.allowlist,
				},
				relay: { running: relayStatus.running, baseUrl: relayStatus.baseUrl, port: relayStatus.port, ...(relayStatus.error ? { error: relayStatus.error } : {}) },
				stats: {
					mappings: store.size(),
					hits: relay.recentHits().length,
					lastTypes: [...new Set(relay.recentHits(20).flatMap((h) => h.types))],
				},
			};
		};

		/** Applies a config change and returns the new panel state. */
		const apply = async (mutate: (draft: VeilConfig) => void): Promise<PanelState> => {
			const draft = structuredClone(configFile.get());
			mutate(draft);
			// Switching the relay on records where each gateway really lives, so a bare-path
			// request can be forwarded there. Turning it off keeps the map for next time.
			if (draft.relay) draft.routes = { ...draft.routes, ...upstreamMap() };
			await configFile.save(draft);
			rebuild();
			await syncRelay();
			// Gateways registered with the relay base URL must be re-registered for the new port.
			await ctx.reloadSessions();
			return state();
		};

		/** Real upstream base URL of every enabled gateway, keyed by gateway id. */
		const upstreamMap = (): Record<string, string> => {
			const out: Record<string, string> = {};
			for (const g of ctx.gateways()) {
				if (g.enabled === false || !g.baseUrl) continue;
				out[g.id] = g.baseUrl;
			}
			return out;
		};

		/**
		 * Starts or stops the relay to match the config. The relay port follows `relayPort`, so a
		 * change needs a restart of the listener.
		 */
		const syncRelay = async (): Promise<void> => {
			const cfg = configFile.get();
			if (!cfg.relay) {
				if (relay.status().running) await relay.stop();
				return;
			}
			const status = relay.status();
			if (status.running && status.port === cfg.relayPort) return;
			if (status.running) await relay.stop();
			const started = await relay.start();
			if (!started.running) ctx.log.warn(`出口代理未能启动：${started.error ?? "未知原因"}`);
		};

		await syncRelay();

		// ---------- provider hooks ----------

		/**
		 * Points every enabled gateway at the local relay, so requests physically leave through the
		 * configured proxy. `registerProvider` with only a `baseUrl` overrides an existing provider's
		 * address; the API key and models stay as Prometheus registered them.
		 */
		const syncGatewayRoutes = (pi: {
			registerProvider: (name: string, config: Record<string, unknown>) => void;
		}): void => {
			const cfg = configFile.get();
			const status = relay.status();
			if (!cfg.relay || !status.running) return;
			for (const gateway of ctx.gateways()) {
				if (gateway.enabled === false) continue;
				// The SDKs append their own path, so a base URL already ending in /v1 must not keep it.
				const base = gateway.format === "anthropic-messages" ? status.baseUrl : `${status.baseUrl}/v1`;
				try {
					pi.registerProvider(gateway.id, { baseUrl: base });
				} catch (err) {
					ctx.log.warn(`无法把网关 ${gateway.id} 指向转发端口：${err instanceof Error ? err.message : String(err)}`);
				}
			}
		};


		ctx.extension((pi) => {
			syncGatewayRoutes(pi as unknown as { registerProvider: (name: string, config: Record<string, unknown>) => void });

			// Outbound: replace secrets with placeholders, and neutralise region-bearing headers.
			pi.on("before_provider_request", (event) => {
				const cfg = configFile.get();
				if (!cfg.redaction) return undefined;
				const payload = event.payload;
				if (payload === undefined || payload === null) return undefined;
				try {
					const parsed = typeof payload === "string" ? parseJson(payload) : (payload as Parameters<typeof desensitizeJson>[0]);
					if (parsed === undefined) {
						return typeof payload === "string" ? desensitizeString(payload, currentRules(), store) : undefined;
					}
					return desensitizeJson(parsed, currentRules(), store);
				} catch (err) {
					// Refusing the request is safer than sending it unscanned.
					ctx.log.error(`脱敏失败，已拦截本次请求：${err instanceof Error ? err.message : String(err)}`);
					throw new Error("面罩：脱敏失败，已拦截本次请求（未发往上游）");
				}
			});

			pi.on("before_provider_headers", (event) => {
				const cfg = configFile.get();
				if (!cfg.regionNeutral) return;
				const headers = event.headers as Record<string, string | null | undefined>;
				for (const key of Object.keys(headers)) {
					const lower = key.toLowerCase();
					if (lower === "accept-language") headers[key] = cfg.acceptLanguage;
					// Compression would hide placeholders from the response rewriter.
					else if (lower === "accept-encoding") headers[key] = "identity";
				}
				if (!Object.keys(headers).some((k) => k.toLowerCase() === "accept-language")) headers["accept-language"] = cfg.acceptLanguage;
				if (!Object.keys(headers).some((k) => k.toLowerCase() === "accept-encoding")) headers["accept-encoding"] = "identity";
			});
		});

		const currentRules = () => ruleset;

		// ---------- RPC for the panel ----------

		/**
		 * One table drives both surfaces: `plugin.call` for in-app callers and `POST /rpc/<method>`
		 * for the sandboxed panel, which has no WebSocket of its own.
		 */
		const handlers: Record<string, RpcHandler> = {
			state: () => state(),

			setFlags: async (params) =>
				apply((draft) => {
					if (params.redaction !== undefined) draft.redaction = bool(params.redaction, draft.redaction);
					if (params.relay !== undefined) draft.relay = bool(params.relay, draft.relay);
					if (params.regionNeutral !== undefined) draft.regionNeutral = bool(params.regionNeutral, draft.regionNeutral);
				}),

			setProxy: async (params) => {
				const raw = str(params.url).trim();
				let proxy: ProxySettings;
				if (!raw) proxy = { kind: "none", server: "" };
				else {
					try {
						proxy = parseProxyUrl(raw);
					} catch (err) {
						throw new Error(err instanceof Error ? err.message : String(err));
					}
				}
				return apply((draft) => {
					draft.proxy = proxy;
				});
			},

			setRelay: async (params) =>
				apply((draft) => {
					if (params.port !== undefined) {
						const port = Number(params.port);
						if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口需在 1024–65535 之间");
						draft.relayPort = port;
					}
					if (params.upstream !== undefined) draft.upstream = str(params.upstream).trim();
				}),

			setHeaders: async (params) =>
				apply((draft) => {
					const lang = str(params.acceptLanguage).trim();
					if (lang) draft.acceptLanguage = lang;
				}),

			setRule: async (params) => {
				const rule = params.rule as Rule | undefined;
				if (!rule || typeof rule !== "object") throw new Error("规则格式不正确");
				validateRule(rule);
				return apply((draft) => {
					const idx = draft.rules.findIndex((r) => r.id === rule.id);
					if (idx === -1) draft.rules.push(rule);
					else draft.rules[idx] = rule;
				});
			},

			toggleRule: async (params) => {
				const id = str(params.id);
				return apply((draft) => {
					const rule = draft.rules.find((r) => r.id === id);
					if (!rule) throw new Error(`没有这条规则：${id}`);
					rule.enabled = bool(params.enabled, rule.enabled);
				});
			},

			deleteRule: async (params) => {
				const id = str(params.id);
				if (builtinRules().some((r) => r.id === id)) throw new Error("内置规则不能删除，可以关掉它");
				return apply((draft) => {
					draft.rules = draft.rules.filter((r) => r.id !== id);
				});
			},

			setPacks: async (params) =>
				apply((draft) => {
					draft.packs = {
						secrets: bool(params.secrets, draft.packs.secrets),
						region: bool(params.region, draft.packs.region),
					};
					// Re-seed from the packs, keeping the user's own rules and their on/off choices.
					const custom = draft.rules.filter((r) => !builtinRules().some((b) => b.id === r.id));
					const disabled = new Set(draft.rules.filter((r) => !r.enabled).map((r) => r.id));
					draft.rules = [...builtinRules(draft.packs).map((r) => ({ ...r, enabled: !disabled.has(r.id) })), ...custom];
				}),

			setAllowlist: async (params) => {
				const lines = Array.isArray(params.allowlist) ? params.allowlist.map((x) => String(x).trim()).filter(Boolean) : [];
				return apply((draft) => {
					draft.allowlist = lines;
				});
			},

			testRules: (params) => {
				const text = str(params.text);
				const hits = currentRules().findHits(text);
				return {
					hits: hits.map((h) => ({ type: h.typePrefix, value: maskValue(h.plaintext) })),
					preview: desensitizeString(text, currentRules(), store),
				};
			},

			mappings: (params) => {
				const limit = typeof params.limit === "number" ? params.limit : 50;
				return { total: store.size(), entries: store.preview(limit) };
			},

			clearMappings: async () => {
				await store.clear();
				return { total: 0 };
			},

			hits: () => ({ entries: relay.recentHits() }),

			clearHits: () => {
				relay.clearHits();
				return { entries: [] };
			},

			restartRelay: async () => {
				if (relay.status().running) await relay.stop();
				await syncRelay();
				return state();
			},
		};

		for (const [method, handler] of Object.entries(handlers)) {
			const wrapped: RpcHandler = async (params) => {
				const result = await handler(params);
				ctx.notifyChanged();
				return result;
			};
			// `plugin.call` only: the view is native and rides the authenticated WebSocket, so the
			// plugin exposes no HTTP surface of its own and needs no separate credential.
			ctx.rpc(method, wrapped);
		}

		// No `ctx.panel()` either: the view lives in the app as a native React page
		// (`apps/web/src/components/VeilView.tsx`), so it inherits the host's skin and theme directly.

		ctx.onDispose(async () => {
			await relay.stop();
			await store.flush();
			await configFile.flush();
		});
	},
});

function buildRuleSet(cfg: VeilConfig): RuleSet {
	return new RuleSet({ rules: cfg.rules, allowlist: cfg.allowlist });
}

/** Makes a secret recognisable in a preview without printing it. */
function maskValue(value: string): string {
	if (value.length <= 6) return "•".repeat(Math.max(3, value.length));
	return `${value.slice(0, 2)}${"•".repeat(Math.min(10, value.length - 6))}${value.slice(-4)}`;
}
