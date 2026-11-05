import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TenantCredentials } from "../auth/tenant-credentials.ts";
import { JWT_AUDIENCE } from "../config.ts";
import type { JwtClaims } from "../jwt.ts";
import type { HubDeps } from "../deps.ts";
import { badRequest, forbidden, HubError, notFound, unauthorized } from "../errors.ts";
import type { RouteContext } from "../http/context.ts";
import { bearerToken, relativePath } from "../http/dispatch.ts";
import { HANDLED } from "../http/router.ts";
import { verifyJwt } from "../jwt.ts";
import { LOG_PREFIX } from "../log.ts";
import type { BillingService } from "../billing/index.ts";
import type { Subject } from "../billing/providers/provider.ts";
import { computeCost, DEFAULT_MAX_TOKENS, type ModelPrice, requestedMaxTokens, type Reservation } from "../billing/wallet.ts";
import { pinnedRequest, resolveSafeTarget } from "../net/safe-url.ts";
import { estimateInputTokens } from "./estimate.ts";
import { type ByokService, safeUrlPolicyOf } from "../services/byok.ts";
import type { GatewayFormat } from "../services/models.ts";
import type { QuotasService } from "../services/quotas.ts";
import type { UsageEntry, UsageService } from "../services/usage.ts";
import { type SelectedGateway, selectGateway } from "./select.ts";
import { hasDotSegment, joinUpstreamUrl } from "./url.ts";
import { createUsageExtractor } from "./usage-extract.ts";

const FORMATS: readonly string[] = ["openai", "anthropic", "gemini"];
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** Client headers that may reach the upstream. Everything else, in particular any credential, is dropped. */
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta", "user-agent"];
const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer", "set-cookie"]);

/** The credential the client used: Bearer (OpenAI style), x-api-key (Anthropic SDK), x-goog-api-key or ?key= (Gemini SDK). */
function clientToken(req: IncomingMessage, searchParams: URLSearchParams): string | undefined {
	const header = (name: string): string | undefined => {
		const v = req.headers[name];
		return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
	};
	return bearerToken(req) ?? header("x-api-key") ?? header("x-goog-api-key") ?? searchParams.get("key") ?? undefined;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		size += buf.length;
		if (size > MAX_REQUEST_BYTES) throw new HubError(413, "payloadTooLarge", "请求体过大");
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

function requestedModel(format: GatewayFormat, rest: string, body: unknown): string | undefined {
	if (format === "gemini") return /(?:^|\/)models\/([^/:]+)/.exec(rest)?.[1];
	if (typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string") return (body as { model: string }).model;
	return undefined;
}

function authHeaders(gateway: SelectedGateway): Record<string, string> {
	switch (gateway.format) {
		case "anthropic":
			return { "x-api-key": gateway.apiKey };
		case "gemini":
			return { "x-goog-api-key": gateway.apiKey };
		default:
			return { authorization: `Bearer ${gateway.apiKey}` };
	}
}

export interface LlmProxy {
	handle(ctx: RouteContext): Promise<typeof HANDLED>;
}

/** `<base>/llm/:format/*`: authenticates with the Hub access token, picks a gateway, checks quota, streams the upstream response through and books usage. */
export function createLlmProxy(deps: HubDeps, quotas: QuotasService, usage: UsageService): LlmProxy {
	/**
	 * Two kinds of caller: a tenant's server with its gateway token (aud `prometheus-llm`, revocable, accepted nowhere else),
	 * and a member's own server with a normal access token. A `scope: "tenant"` access token is not an LLM credential.
	 */
	async function authenticate(token: string): Promise<JwtClaims | undefined> {
		const credentials = deps.registry.get<TenantCredentials>("tenantCredentials");
		const gateway = credentials ? await credentials.verify(token, "gateway") : undefined;
		if (gateway) return gateway;
		const claims = verifyJwt(token, { publicKey: deps.publicKeyPem, issuer: deps.config.issuer, audience: JWT_AUDIENCE });
		if (claims?.scope !== undefined) throw forbidden("租户访问令牌不能调用模型接口，请使用网关令牌", "tenantScope");
		return claims;
	}

	return {
		async handle(ctx) {
			const format = ctx.params.format as string;
			if (!FORMATS.includes(format)) throw notFound("不支持的接口格式");

			const token = clientToken(ctx.req, ctx.searchParams);
			const claims = token ? await authenticate(token) : undefined;
			if (!claims) throw unauthorized(token ? "访问令牌无效或已过期" : "需要登录", "invalidToken");
			const actor = await deps.services.actors.load(claims.sub);

			const pathname = new URL(ctx.req.url ?? "/", "http://hub.local").pathname;
			const rel = relativePath(deps.config, pathname) ?? pathname;
			const prefix = `/llm/${format}/`;
			const rest = rel.startsWith(prefix) ? rel.slice(prefix.length) : "";
			if (hasDotSegment(rest)) throw badRequest("请求路径无效", "invalidPath");

			const hasBody = ctx.method !== "GET" && ctx.method !== "HEAD";
			const raw = hasBody ? await readBody(ctx.req) : Buffer.alloc(0);
			let parsed: unknown;
			if (raw.length > 0) {
				try {
					parsed = JSON.parse(raw.toString("utf8"));
				} catch {
					parsed = undefined;
				}
			}
			const model = requestedModel(format as GatewayFormat, rest, parsed);

			const orgIds = Object.keys(actor.orgRoles);
			// With billing on, `X-Prometheus-Org` picks the organization whose wallet pays (it must be one the user belongs to).
			const billing = deps.config.billingEnabled ? deps.registry.get<BillingService>("billing") : undefined;
			let billingOrg: string | undefined;
			if (billing) {
				const wanted = ctx.req.headers["x-prometheus-org"];
				const orgHeader = (Array.isArray(wanted) ? wanted[0] : wanted)?.trim();
				if (orgHeader) {
					if (!actor.orgRoles[orgHeader]) throw forbidden("你不是该企业的成员", "forbidden");
					billingOrg = orgHeader;
				}
			}
			// Personal gateways are selectable only while BYOK is allowed for this user.
			const byok = deps.registry.get<ByokService>("byok");
			const ownAllowed = byok ? await byok.isAllowed(orgIds) : false;
			const selection = await selectGateway(deps.db, deps.secretBox, deps.log, { orgIds, format: format as GatewayFormat, model, ...(ownAllowed ? { userId: actor.userId } : {}) });
			const gateway = selection.chosen;
			if (!gateway) {
				if (selection.candidates > 0) throw new HubError(400, "modelNotAvailable", `模型 ${model ?? ""} 不在可用网关的模型列表中`);
				throw new HubError(404, "noGateway", "没有可用的模型网关");
			}
			await quotas.check(actor.userId, orgIds);

			// Credits (block 4B): only the operator's own gateways cost credits, and only while billing is on.
			let charge: { subject: Subject; price: ModelPrice | undefined; reservation: Reservation | undefined } | undefined;
			const releaseHold = async (): Promise<void> => {
				if (!billing || !charge?.reservation) return;
				await billing.wallet.release(charge.reservation).catch((err: unknown) => deps.log.warn(`${LOG_PREFIX} 释放额度预留失败: ${err instanceof Error ? err.message : String(err)}`));
			};
			if (billing && gateway.scope === "platform") {
				const subject: Subject = billingOrg ? { type: "org", id: billingOrg } : { type: "user", id: actor.userId };
				const price = await billing.wallet.priceFor(model ?? "unknown", gateway.id);
				// Free calls through the operator's own gateways would let anyone run up the operator's bill.
				if (!price) throw new HubError(403, "modelNotPriced", `模型 ${model ?? "unknown"} 尚未定价，不能通过平台网关调用`);
				// The estimate counts the prompt as well as the output cap: a huge prompt with a tiny max_tokens used to pass.
				const estimate = computeCost(price, estimateInputTokens(parsed, raw.length), requestedMaxTokens(parsed) ?? DEFAULT_MAX_TOKENS);
				await billing.wallet.ensureGrants(subject);
				// Hold the estimate until the call settles: concurrent calls each see the others' holds, so together they cannot overspend.
				// Throws 402 when the unreserved balance is short.
				charge = { subject, price, reservation: await billing.wallet.reserve(subject, estimate) };
			}

			let body: Buffer | undefined = hasBody ? raw : undefined;
			if (format === "openai" && rest.replace(/\/+$/, "").endsWith("chat/completions") && typeof parsed === "object" && parsed !== null) {
				const p = parsed as { stream?: unknown; stream_options?: { include_usage?: unknown } };
				// Streamed Chat Completions only report usage when asked to; the accounting depends on it.
				if (p.stream === true && p.stream_options?.include_usage !== true) {
					body = Buffer.from(JSON.stringify({ ...p, stream_options: { ...(typeof p.stream_options === "object" && p.stream_options ? p.stream_options : {}), include_usage: true } }));
				}
			}

			const query = new URLSearchParams(ctx.searchParams);
			query.delete("key");
			const headers = new Headers();
			for (const name of FORWARD_REQUEST_HEADERS) {
				const v = ctx.req.headers[name];
				if (typeof v === "string") headers.set(name, v);
			}
			for (const [k, v] of Object.entries(authHeaders(gateway))) headers.set(k, v);
			if (gateway.format === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");

			const abort = new AbortController();
			const res: ServerResponse = ctx.res;
			res.on("close", () => {
				if (!res.writableEnded) abort.abort();
			});

			let upstream: Response;
			try {
				const upstreamUrl = joinUpstreamUrl(gateway.baseUrl, rest, query);
				if (gateway.scope === "user") {
					// User supplied address: vet it again now (DNS may have changed since it was saved) and connect to exactly the vetted IP.
					const target = await resolveSafeTarget(upstreamUrl, safeUrlPolicyOf(deps.config));
					upstream = await pinnedRequest(target, { method: ctx.method, headers, body, signal: abort.signal });
				} else {
					upstream = await fetch(upstreamUrl, { method: ctx.method, headers, body, signal: abort.signal, redirect: "manual" });
				}
			} catch (err) {
				await releaseHold();
				if (abort.signal.aborted) return HANDLED;
				if (err instanceof HubError) {
					deps.log.warn(`${LOG_PREFIX} 个人网关 ${gateway.id} 的上游请求被拒绝: ${err.message}`);
					throw new HubError(502, err.code === "unsafeUrl" ? "unsafeUpstream" : err.code, err.code === "unsafeUrl" ? "个人网关的地址不被允许" : err.message);
				}
				deps.log.warn(`${LOG_PREFIX} 上游模型服务请求失败 (网关 ${gateway.id}): ${err instanceof Error ? err.message : String(err)}`);
				throw new HubError(502, "upstreamError", "无法连接上游模型服务");
			}

			const outHeaders: Record<string, string> = {};
			upstream.headers.forEach((value, key) => {
				if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) outHeaders[key] = value;
			});
			res.writeHead(upstream.status, outHeaders);

			const extractor = upstream.ok ? createUsageExtractor(gateway.format, upstream.headers.get("content-type")) : undefined;
			try {
				if (upstream.body) {
					for await (const chunk of upstream.body) {
						extractor?.push(chunk);
						if (res.destroyed) break;
						if (!res.write(chunk)) await once(res, "drain");
					}
				}
			} catch (err) {
				if (!abort.signal.aborted) deps.log.warn(`${LOG_PREFIX} 转发上游响应中断 (网关 ${gateway.id}): ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				if (!res.writableEnded && !res.destroyed) res.end();
			}

			const used = extractor?.end();
			// No usage (upstream error, empty or aborted stream): nothing is charged, so the hold goes back.
			if (!used) await releaseHold();
			if (used) {
				const claimedOrg = billingOrg ?? (claims.org && actor.orgRoles[claims.org] ? claims.org : (orgIds[0] ?? null));
				const entry: UsageEntry = {
					userId: actor.userId,
					orgId: gateway.scope === "org" ? gateway.orgId : claimedOrg,
					gatewayId: gateway.id,
					model: model ?? "unknown",
					inputTokens: used.inputTokens,
					outputTokens: used.outputTokens,
					source: gateway.scope === "user" ? "byok" : gateway.scope,
				};
				try {
					if (billing && charge) await billing.wallet.commit(charge.reservation, charge.subject, entry, charge.price);
					else await usage.record(entry);
				} catch (err) {
					deps.log.error(`${LOG_PREFIX} 记录模型用量失败: ${err instanceof Error ? err.message : String(err)}`);
					await releaseHold();
				}
			}
			return HANDLED;
		},
	};
}
