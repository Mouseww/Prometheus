import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginLogger } from "@prometheus/plugin-sdk";
import { type Envelope, errorMessage, LOG, TeamError } from "../types.ts";
import type { StateStore } from "./state.ts";

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HUB_PREFIX = "/plugins/team";

export const TOKEN_FILE = "access-token";

export interface HubClientOptions {
	state: StateStore;
	log: PluginLogger;
	fetch?: typeof fetch;
	now?: () => number;
	/**
	 * Tenant instance mode (block 3B): the Hub started this server for its owner and gave it a long-lived credential
	 * (`TEAM_TENANT_TOKEN`). There is no password and no refresh token; access tokens come from `/auth/tenant-token`.
	 */
	tenant?: { hubUrl: string; token: string };
}

export interface HubReply<T = unknown> {
	status: number;
	envelope: Envelope<T>;
}

interface TokenPair {
	accessToken: string;
	refreshToken: string;
	user: { id: string; email?: string; displayName?: string };
}

/** Milliseconds since the epoch at which a JWT expires (0 when it cannot be read). */
export function jwtExpiryMs(token: string): number {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
		return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
	} catch {
		return 0;
	}
}

/** The `sub` claim of a JWT (the user id), or undefined when it cannot be read. The signature is not checked: the Hub does that. */
export function jwtSubject(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
		return typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
	} catch {
		return undefined;
	}
}

export function normalizeHubUrl(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) throw new TeamError("invalidParams", "需要提供 Hub 地址 hubUrl");
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new TeamError("invalidParams", "Hub 地址无效");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new TeamError("invalidParams", "Hub 地址必须以 http:// 或 https:// 开头");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/, "");
}

/** Talks to the Hub as the signed-in member: keeps the access token fresh (and on disk for the model provider) and retries once on 401. */
export class HubClient {
	private readonly opts: HubClientOptions;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private accessToken: string | undefined;
	private expiresAt = 0;
	private refreshing: Promise<string> | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly listeners = new Set<(token: string | undefined) => void>();

	constructor(opts: HubClientOptions) {
		this.opts = opts;
		this.fetchImpl = opts.fetch ?? fetch;
		this.now = opts.now ?? Date.now;
	}

	get tokenFile(): string {
		return join(this.opts.state.dir, TOKEN_FILE);
	}

	get hubUrl(): string | undefined {
		return this.opts.tenant?.hubUrl ?? this.opts.state.get().hubUrl;
	}

	get loggedIn(): boolean {
		return Boolean(this.opts.tenant) || Boolean(this.opts.state.get().refreshToken);
	}

	/** The tenant credential, when this server is a tenant instance (the WebSocket presents it directly). */
	get tenantToken(): string | undefined {
		return this.opts.tenant?.token;
	}

	/** Called with the new token after every refresh and with undefined after logout. */
	onToken(listener: (token: string | undefined) => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	apiUrl(path: string, hubUrl = this.hubUrl): string {
		if (!hubUrl) throw new TeamError("notLoggedIn", "尚未连接团队 Hub", 401);
		return `${hubUrl}${HUB_PREFIX}/api${path}`;
	}

	private async plain(method: string, url: string, body?: unknown, token?: string): Promise<HubReply> {
		const headers: Record<string, string> = {};
		if (token) headers.authorization = `Bearer ${token}`;
		if (body !== undefined) headers["content-type"] = "application/json";
		let res: Response;
		try {
			res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		} catch (err) {
			return { status: 502, envelope: { ok: false, error: { code: "hubUnreachable", message: `无法连接团队 Hub: ${errorMessage(err)}` } } };
		}
		const text = await res.text();
		try {
			const parsed = JSON.parse(text) as Envelope;
			if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") return { status: res.status, envelope: parsed };
		} catch {
			// Not JSON: fall through to a synthetic envelope.
		}
		return { status: res.status, envelope: { ok: false, error: { code: "badGateway", message: `Hub 返回了无法识别的响应 (HTTP ${res.status})` } } };
	}

	private async adopt(pair: TokenPair, hubUrl: string): Promise<void> {
		this.accessToken = pair.accessToken;
		this.expiresAt = jwtExpiryMs(pair.accessToken);
		await this.opts.state.update((s) => ({
			...s,
			hubUrl,
			refreshToken: pair.refreshToken,
			userId: pair.user.id,
			...(pair.user.displayName ? { displayName: pair.user.displayName } : {}),
			...(pair.user.email ? { email: pair.user.email } : {}),
		}));
		await this.writeTokenFile(pair.accessToken);
		this.schedule();
		for (const l of this.listeners) l(pair.accessToken);
	}

	private async writeTokenFile(token: string): Promise<void> {
		await writeFile(this.tokenFile, token, { mode: 0o600 });
		await chmod(this.tokenFile, 0o600).catch(() => {});
	}

	/** Refresh shortly before expiry so the token file read by the model provider is always usable. */
	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		if (!this.expiresAt) return;
		const wait = Math.max(5_000, this.expiresAt - this.now() - REFRESH_MARGIN_MS);
		this.timer = setTimeout(() => {
			this.ensureToken(true).catch((err: unknown) => this.opts.log.warn(`${LOG} 自动刷新访问令牌失败: ${errorMessage(err)}`));
		}, Math.min(wait, 2 ** 30));
		this.timer.unref();
	}

	private fail(reply: HubReply, fallback: string): never {
		throw new TeamError(reply.envelope.error?.code ?? "hubError", reply.envelope.error?.message ?? fallback, reply.status);
	}

	async login(hubUrlRaw: unknown, email: unknown, password: unknown): Promise<TokenPair["user"]> {
		const hubUrl = normalizeHubUrl(hubUrlRaw);
		if (typeof email !== "string" || !email || typeof password !== "string" || !password) throw new TeamError("invalidParams", "需要邮箱和密码");
		const reply = await this.plain("POST", this.apiUrl("/auth/login", hubUrl), { email, password });
		if (!reply.envelope.ok) this.fail(reply, "登录失败");
		const pair = reply.envelope.data as TokenPair;
		await this.adopt(pair, hubUrl);
		return pair.user;
	}

	/** Creates an account. Resolves with the Hub's registration result; the caller logs in afterwards when the account is active. */
	async register(hubUrlRaw: unknown, body: Record<string, unknown>): Promise<{ hubUrl: string; result: { status: string; user: unknown; bootstrap: boolean } }> {
		const hubUrl = normalizeHubUrl(hubUrlRaw);
		const payload: Record<string, unknown> = {};
		for (const key of ["email", "password", "displayName", "setupCode", "inviteToken"]) {
			if (typeof body[key] === "string" && body[key] !== "") payload[key] = body[key];
		}
		const reply = await this.plain("POST", this.apiUrl("/auth/register", hubUrl), payload);
		if (!reply.envelope.ok) this.fail(reply, "注册失败");
		return { hubUrl, result: reply.envelope.data as { status: string; user: unknown; bootstrap: boolean } };
	}

	async logout(): Promise<void> {
		// A tenant instance belongs to the Hub: there is nothing to log out of.
		if (this.opts.tenant) return;
		const { refreshToken, hubUrl } = this.opts.state.get();
		if (refreshToken && hubUrl) await this.plain("POST", this.apiUrl("/auth/logout", hubUrl), { refreshToken }).catch(() => {});
		await this.forget();
	}

	/** Drops the credentials (the session mapping stays: it describes local folders, not the login). */
	async forget(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.accessToken = undefined;
		this.expiresAt = 0;
		await this.opts.state.update((s) => {
			const { refreshToken: _r, userId: _u, displayName: _d, email: _e, ...rest } = s;
			return rest;
		});
		await rm(this.tokenFile, { force: true });
		for (const l of this.listeners) l(undefined);
	}

	/** A valid access token, refreshed when it is missing or about to expire (`force` always refreshes). */
	async ensureToken(force = false): Promise<string> {
		if (!force && this.accessToken && this.expiresAt - REFRESH_MARGIN_MS > this.now()) return this.accessToken;
		if (!this.refreshing) {
			this.refreshing = this.refresh().finally(() => {
				this.refreshing = undefined;
			});
		}
		return this.refreshing;
	}

	private async refreshTenant(tenant: { hubUrl: string; token: string }): Promise<string> {
		const reply = await this.plain("POST", this.apiUrl("/auth/tenant-token", tenant.hubUrl), undefined, tenant.token);
		if (!reply.envelope.ok) {
			if (reply.status === 401 || reply.status === 403) throw new TeamError("notLoggedIn", "租户凭证已失效，请重启租户实例", 401);
			this.fail(reply, "换取租户访问令牌失败");
		}
		const data = reply.envelope.data as { accessToken: string; user: TokenPair["user"] };
		this.accessToken = data.accessToken;
		this.expiresAt = jwtExpiryMs(data.accessToken);
		await this.opts.state.update((s) => ({ ...s, hubUrl: tenant.hubUrl, userId: data.user.id, ...(data.user.displayName ? { displayName: data.user.displayName } : {}), ...(data.user.email ? { email: data.user.email } : {}) }));
		await this.writeTokenFile(data.accessToken);
		this.schedule();
		for (const l of this.listeners) l(data.accessToken);
		return data.accessToken;
	}

	private async refresh(): Promise<string> {
		if (this.opts.tenant) return this.refreshTenant(this.opts.tenant);
		const { refreshToken, hubUrl } = this.opts.state.get();
		if (!refreshToken || !hubUrl) throw new TeamError("notLoggedIn", "尚未登录团队 Hub", 401);
		const reply = await this.plain("POST", this.apiUrl("/auth/refresh", hubUrl), { refreshToken });
		if (!reply.envelope.ok) {
			// The Hub refused the refresh token (expired, revoked or already rotated): the login is over. A network failure is not.
			if (reply.status === 401 || reply.status === 403) {
				await this.forget();
				throw new TeamError("notLoggedIn", "登录已失效，请重新登录团队 Hub", 401);
			}
			this.fail(reply, "刷新访问令牌失败");
		}
		const pair = reply.envelope.data as TokenPair;
		await this.adopt(pair, hubUrl);
		return pair.accessToken;
	}

	/** An authenticated call; a 401 triggers one refresh and one retry. The Hub's envelope comes back unchanged. */
	async request<T = unknown>(method: string, path: string, body?: unknown): Promise<HubReply<T>> {
		const url = this.apiUrl(path);
		let token: string;
		try {
			token = await this.ensureToken();
		} catch (err) {
			if (err instanceof TeamError) return { status: err.status, envelope: { ok: false, error: { code: err.code, message: err.message } } };
			throw err;
		}
		let reply = (await this.plain(method, url, body, token)) as HubReply<T>;
		if (reply.status === 401) {
			try {
				token = await this.ensureToken(true);
			} catch (err) {
				if (err instanceof TeamError) return { status: err.status, envelope: { ok: false, error: { code: err.code, message: err.message } } };
				throw err;
			}
			reply = (await this.plain(method, url, body, token)) as HubReply<T>;
		}
		return reply;
	}

	/** Like `request` but resolves with the data and throws a TeamError for any failure. */
	async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const reply = await this.request<T>(method, path, body);
		if (!reply.envelope.ok) this.fail(reply, `请求 ${method} ${path} 失败`);
		return reply.envelope.data as T;
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.listeners.clear();
	}
}
