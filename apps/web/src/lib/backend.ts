import type { BackendTarget } from "./client.ts";

const REMOTE_KEY = "prometheus.remote";
const TOKEN_KEY = "prometheus.token";
const MODE_KEY = "prometheus.mode";

export interface RemoteConfig {
	url: string;
	token?: string;
}

export type ConnectionMode = "local" | "remote";

export function isTauri(): boolean {
	return "__TAURI_INTERNALS__" in window;
}

export function targetFromUrl(url: string, token?: string): BackendTarget {
	const u = new URL(url);
	const wsProtocol = u.protocol === "https:" ? "wss:" : "ws:";
	return { wsUrl: `${wsProtocol}//${u.host}/ws`, httpBase: u.origin, token: token || undefined, label: u.host };
}

export function loadRemote(): RemoteConfig | null {
	try {
		const raw = localStorage.getItem(REMOTE_KEY);
		return raw ? (JSON.parse(raw) as RemoteConfig) : null;
	} catch {
		return null;
	}
}

export function saveRemote(config: RemoteConfig | null): void {
	if (config) localStorage.setItem(REMOTE_KEY, JSON.stringify(config));
	else localStorage.removeItem(REMOTE_KEY);
}

export function saveSameOriginToken(token: string | null): void {
	if (token) localStorage.setItem(TOKEN_KEY, token);
	else localStorage.removeItem(TOKEN_KEY);
}

export function loadMode(): ConnectionMode | null {
	const v = localStorage.getItem(MODE_KEY);
	return v === "local" || v === "remote" ? v : null;
}

export function saveMode(mode: ConnectionMode | null): void {
	if (mode) localStorage.setItem(MODE_KEY, mode);
	else localStorage.removeItem(MODE_KEY);
}

/** Desktop builds can spawn a local server; mobile builds are thin clients. */
export async function localSupported(): Promise<boolean> {
	if (!isTauri()) return false;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		return await invoke<boolean>("local_supported");
	} catch {
		return false;
	}
}

/** Start (or reuse) the bundled local server and return its address with the one-time token. */
export async function startLocal(): Promise<BackendTarget> {
	const { invoke } = await import("@tauri-apps/api/core");
	const info = await invoke<{ port: number; token: string } | null>("start_local_backend");
	if (!info) throw new Error("local mode unavailable");
	return { ...targetFromUrl(`http://127.0.0.1:${info.port}`, info.token), label: "local" };
}

/**
 * Desktop: the saved mode decides (local spawns the server). Browser: same origin as the page,
 * unless a remote server was saved.
 */
export async function discoverBackend(): Promise<BackendTarget | null> {
	const mode = loadMode();
	if (isTauri()) {
		if (mode === "local") return startLocal();
		const remote = loadRemote();
		return mode === "remote" && remote ? targetFromUrl(remote.url, remote.token) : null;
	}
	const remote = loadRemote();
	if (remote) return targetFromUrl(remote.url, remote.token);
	if (location.protocol.startsWith("http")) {
		return targetFromUrl(location.origin, localStorage.getItem(TOKEN_KEY) ?? undefined);
	}
	return null;
}

export type PasswordLogin = { ok: true; token: string } | { ok: false; message: string };

/** Signs in with the server's login password over a throwaway socket; on success the session token replaces the password. */
export function passwordLogin(target: BackendTarget, secret: string): Promise<PasswordLogin> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (r: PasswordLogin) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ws.close();
			resolve(r);
		};
		const ws = new WebSocket(target.wsUrl);
		const timer = setTimeout(() => done({ ok: false, message: "连接超时" }), 15_000);
		ws.onerror = () => done({ ok: false, message: "无法连接到服务器" });
		ws.onclose = () => done({ ok: false, message: "连接被服务器关闭，请检查地址和域名白名单" });
		ws.onmessage = (ev) => {
			let f: { type?: string; login?: string; authRequired?: boolean; token?: string; message?: string };
			try {
				f = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (f.type === "hello") {
				if (f.login === "password") ws.send(JSON.stringify({ type: "login", password: secret }));
				else done({ ok: false, message: f.authRequired ? "该服务器使用访问令牌而不是密码" : "该服务器不需要登录" });
			} else if (f.type === "login_failed") done({ ok: false, message: f.message ?? "登录失败" });
			else if (f.type === "auth_ok" && f.token) done({ ok: true, token: f.token });
		};
	});
}

/** Remember a signed-in session for the page's own server or a saved remote one. */
export function saveSession(target: BackendTarget, token: string): void {
	if (!isTauri() && target.httpBase === location.origin && !loadRemote()) saveSameOriginToken(token);
	else saveRemote({ url: target.httpBase, token });
}

/** Forget the saved session of the server this page is connected to. */
export function clearSession(target: BackendTarget): void {
	if (target.httpBase === location.origin) saveSameOriginToken(null);
	const remote = loadRemote();
	if (remote && new URL(remote.url).origin === target.httpBase) saveRemote({ url: remote.url });
}

/** Exchange the token for an HttpOnly cookie so plugin panel iframes can load protected routes. */
export async function establishCookie(target: BackendTarget): Promise<void> {
	if (!target.token || target.httpBase !== location.origin) return;
	await fetch(`${target.httpBase}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: target.token }),
		credentials: "include",
	}).catch(() => {});
}
