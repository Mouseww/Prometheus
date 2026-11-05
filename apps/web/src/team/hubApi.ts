// Hub mode transport: the browser talks to the Hub itself and holds its own tokens.
// Access token in sessionStorage; refresh token in localStorage only when "remember me" was ticked
// (otherwise sessionStorage, so a reload inside the same tab keeps the login but closing the tab ends it).
import {
	createApiMethods,
	HUB_API_BASE,
	HUB_WS_PATH,
	type HubApi,
	TeamApiError,
	type TeamEvent,
	type Requester,
	type Unsubscribe,
	unwrapEnvelope,
} from "./api.ts";
import type { AcceptedInvitation, InvitationView, MetaInfo, PublicUser, RegisterInput, RegisterResult, TokenPair, VerifyEmailResult } from "./types.ts";

export const ACCESS_KEY = "prometheus.team.access";
export const REFRESH_KEY = "prometheus.team.refresh";

export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface SocketLike {
	onopen: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
	onclose: ((ev: unknown) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	send(data: string): void;
	close(): void;
}

export interface HubApiOptions {
	fetch?: typeof fetch;
	/** sessionStorage by default. */
	session?: KeyValueStore;
	/** localStorage by default. */
	local?: KeyValueStore;
	baseUrl?: string;
	/** Builds the WebSocket for an access token. */
	openSocket?: (token: string) => SocketLike;
	/** Reconnect backoff cap in ms (spec: at most 30 s). */
	maxBackoffMs?: number;
}

const safeStore = (pick: () => Storage): KeyValueStore => ({
	getItem: (k) => {
		try {
			return pick().getItem(k);
		} catch {
			return null;
		}
	},
	setItem: (k, v) => {
		try {
			pick().setItem(k, v);
		} catch {
			/* storage blocked: the login simply does not survive a reload */
		}
	},
	removeItem: (k) => {
		try {
			pick().removeItem(k);
		} catch {
			/* ignore */
		}
	},
});

/** Seconds-since-epoch `exp` of a JWT, or undefined when it cannot be read. */
export function jwtExpiry(token: string): number | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
		const exp = (JSON.parse(json) as { exp?: unknown }).exp;
		return typeof exp === "number" ? exp : undefined;
	} catch {
		return undefined;
	}
}

export function createHubApi(options: HubApiOptions = {}): HubApi {
	const doFetch: typeof fetch = options.fetch ?? ((...a) => fetch(...a));
	const session = options.session ?? safeStore(() => sessionStorage);
	const local = options.local ?? safeStore(() => localStorage);
	const base = options.baseUrl ?? HUB_API_BASE;
	const maxBackoff = options.maxBackoffMs ?? 30_000;
	const endListeners = new Set<() => void>();

	const getAccess = (): string | null => session.getItem(ACCESS_KEY);
	const getRefresh = (): string | null => local.getItem(REFRESH_KEY) ?? session.getItem(REFRESH_KEY);
	const remembered = (): boolean => local.getItem(REFRESH_KEY) !== null;

	function storeTokens(pair: Pick<TokenPair, "accessToken" | "refreshToken">, remember: boolean): void {
		session.setItem(ACCESS_KEY, pair.accessToken);
		if (remember) {
			local.setItem(REFRESH_KEY, pair.refreshToken);
			session.removeItem(REFRESH_KEY);
		} else {
			session.setItem(REFRESH_KEY, pair.refreshToken);
			local.removeItem(REFRESH_KEY);
		}
	}
	function clearTokens(): void {
		session.removeItem(ACCESS_KEY);
		session.removeItem(REFRESH_KEY);
		local.removeItem(REFRESH_KEY);
	}
	/** Clears the tokens and tells listeners once; a second call with nothing stored is silent. */
	function endSession(): void {
		const had = getAccess() !== null || getRefresh() !== null;
		clearTokens();
		if (had) for (const cb of [...endListeners]) cb();
	}

	async function raw<T>(method: string, path: string, body: unknown, token: string | null): Promise<{ status: number; value: T | undefined; error?: TeamApiError }> {
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (token) headers.authorization = `Bearer ${token}`;
		let res: Response;
		try {
			res = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		} catch (err) {
			return { status: 0, value: undefined, error: new TeamApiError(0, "network", err instanceof Error ? err.message : String(err)) };
		}
		let parsed: unknown;
		try {
			parsed = await res.json();
		} catch {
			return { status: res.status, value: undefined, error: new TeamApiError(res.status, "badResponse", `HTTP ${res.status}`) };
		}
		try {
			return { status: res.status, value: unwrapEnvelope<T>(parsed, res.status) };
		} catch (err) {
			return { status: res.status, value: undefined, error: err as TeamApiError };
		}
	}

	let refreshing: Promise<boolean> | undefined;
	/** Single-flight: concurrent 401s share one refresh call. Resolves false (and ends the session) when it fails. */
	function refreshTokens(): Promise<boolean> {
		refreshing ??= (async () => {
			const refreshToken = getRefresh();
			if (!refreshToken) return false;
			const remember = remembered();
			const r = await raw<TokenPair>("POST", "/api/auth/refresh", { refreshToken }, null);
			if (r.error || !r.value) {
				// A network blip must not log the user out; only a definitive rejection does.
				if (r.status === 0 || r.status >= 500) return false;
				endSession();
				return false;
			}
			storeTokens(r.value, remember);
			return true;
		})().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	}

	async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
		let r = await raw<T>(method, path, body, auth ? getAccess() : null);
		if (auth && r.status === 401 && getRefresh()) {
			if (await refreshTokens()) r = await raw<T>(method, path, body, getAccess());
		}
		if (r.error) {
			if (auth && r.status === 401 && !getRefresh()) endSession();
			throw r.error;
		}
		return r.value as T;
	}

	const requester: Requester = { request: (m, p, b) => request(m, p, b) };
	const methods = createApiMethods(requester);

	// ---- realtime ----
	const listeners = new Map<string, Set<(event: TeamEvent) => void>>();
	let socket: SocketLike | undefined;
	let attempt = 0;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let pingTimer: ReturnType<typeof setInterval> | undefined;

	const defaultSocket = (token: string): SocketLike => {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		return new WebSocket(`${proto}://${location.host}${HUB_WS_PATH}?token=${encodeURIComponent(token)}`) as unknown as SocketLike;
	};
	const openSocket = options.openSocket ?? defaultSocket;

	function stopSocket(): void {
		clearTimeout(reconnectTimer);
		clearInterval(pingTimer);
		reconnectTimer = undefined;
		const s = socket;
		socket = undefined;
		if (s) {
			s.onclose = null;
			s.close();
		}
	}

	async function connect(): Promise<void> {
		if (socket || listeners.size === 0) return;
		let token = getAccess();
		const exp = token ? jwtExpiry(token) : undefined;
		if ((!token || (exp !== undefined && exp * 1000 < Date.now() + 5_000)) && getRefresh()) {
			await refreshTokens();
			token = getAccess();
		}
		if (!token || socket || listeners.size === 0) return;
		const s = openSocket(token);
		socket = s;
		s.onopen = () => {
			attempt = 0;
			for (const topic of listeners.keys()) s.send(JSON.stringify({ type: "subscribe", topic }));
			clearInterval(pingTimer);
			pingTimer = setInterval(() => s.send(JSON.stringify({ type: "ping" })), 25_000);
		};
		s.onmessage = (ev) => {
			if (typeof ev.data !== "string") return;
			let msg: { type?: string; topic?: string; data?: unknown };
			try {
				msg = JSON.parse(ev.data) as typeof msg;
			} catch {
				return;
			}
			if (msg.type !== "event" || typeof msg.topic !== "string") return;
			for (const cb of [...(listeners.get(msg.topic) ?? [])]) cb(msg.data);
		};
		s.onclose = () => {
			clearInterval(pingTimer);
			socket = undefined;
			if (listeners.size === 0) return;
			const delay = Math.min(maxBackoff, 1000 * 2 ** attempt);
			attempt += 1;
			reconnectTimer = setTimeout(() => void connect(), delay);
		};
		s.onerror = () => undefined;
	}

	function subscribe(topic: string, cb: (event: TeamEvent) => void): Unsubscribe {
		let set = listeners.get(topic);
		const first = !set;
		if (!set) {
			set = new Set();
			listeners.set(topic, set);
		}
		set.add(cb);
		if (socket) {
			if (first) socket.send(JSON.stringify({ type: "subscribe", topic }));
		} else void connect();
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const cur = listeners.get(topic);
			cur?.delete(cb);
			if (cur && cur.size === 0) listeners.delete(topic);
			if (listeners.size === 0) stopSocket();
		};
	}

	return {
		...methods,
		subscribe,
		meta: () => request<MetaInfo>("GET", "/api/meta", undefined, false),
		async login(email, password, remember): Promise<PublicUser> {
			const pair = await request<TokenPair>("POST", "/api/auth/login", { email, password }, false);
			storeTokens(pair, remember);
			return pair.user;
		},
		register: (input: RegisterInput) => request<RegisterResult>("POST", "/api/auth/register", input, false),
		verifyEmail: (token) => request<VerifyEmailResult>("POST", "/api/auth/verify-email", { token }, false),
		async resendVerification(email): Promise<void> {
			await request<unknown>("POST", "/api/auth/resend-verification", { email }, false);
		},
		async forgotPassword(email): Promise<void> {
			await request<unknown>("POST", "/api/auth/forgot-password", { email }, false);
		},
		async resetPassword(token, password): Promise<void> {
			await request<unknown>("POST", "/api/auth/reset-password", { token, password }, false);
		},
		lookupInvitation: (token) => request<InvitationView>("GET", `/api/invitations/${encodeURIComponent(token)}`, undefined, false),
		acceptInvitation: (token) => request<AcceptedInvitation>("POST", `/api/invitations/${encodeURIComponent(token)}/accept`, {}),
		async logout(): Promise<void> {
			const refreshToken = getRefresh();
			stopSocket();
			if (refreshToken) await raw("POST", "/api/auth/logout", { refreshToken }, null);
			endSession();
		},
		hasSession: () => getAccess() !== null || getRefresh() !== null,
		onSessionEnd(cb) {
			endListeners.add(cb);
			return () => endListeners.delete(cb);
		},
	};
}
