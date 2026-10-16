import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { TAURI_ORIGINS } from "./security.ts";

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HOSTS = 50;

// ---------- password hashing ----------

const SCRYPT_N = 16384;

function derive(password: string, salt: Buffer, n: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, 32, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
	});
}

export function checkPasswordRules(password: unknown): string {
	if (typeof password !== "string") throw new Error("密码格式不正确");
	if (password.length < MIN_PASSWORD) throw new Error(`密码至少需要 ${MIN_PASSWORD} 个字符`);
	if (password.length > MAX_PASSWORD) throw new Error(`密码不能超过 ${MAX_PASSWORD} 个字符`);
	return password;
}

/** `scrypt$N$salt$hash`; the cost is stored so it can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, SCRYPT_N);
	return `scrypt$${SCRYPT_N}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
	const [scheme, cost, salt, hash] = (stored ?? "").split("$");
	const n = Number(cost);
	if (scheme !== "scrypt" || !salt || !hash || !Number.isInteger(n) || n < 1024 || n > 1 << 20) return false;
	const expected = Buffer.from(hash, "base64url");
	if (expected.length !== 32 || password.length > MAX_PASSWORD) return false;
	const actual = await derive(password, Buffer.from(salt, "base64url"), n);
	return timingSafeEqual(actual, expected);
}

// ---------- session tokens ----------

export const newSecret = (): string => randomBytes(32).toString("base64url");

const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

/** Stateless: `v1.<expiry>.<nonce>.<hmac>`. Rotating the secret signs every device out. */
export function signSession(secret: string, now = Date.now(), ttlMs = SESSION_TTL_MS): string {
	const body = `${now + ttlMs}.${randomBytes(8).toString("base64url")}`;
	return `v1.${body}.${mac(secret, body)}`;
}

export function verifySession(secret: string | undefined, token: string, now = Date.now()): boolean {
	if (!secret) return false;
	const parts = token.split(".");
	if (parts.length !== 4 || parts[0] !== "v1") return false;
	const [, exp, nonce, sig] = parts as [string, string, string, string];
	if (!(Number(exp) > now)) return false;
	const expected = Buffer.from(mac(secret, `${exp}.${nonce}`));
	const given = Buffer.from(sig);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------- brute-force limiter ----------

interface Entry {
	fails: number;
	until: number;
	last: number;
}

/** Counts failed logins per key; after `free` failures the key is locked for an exponentially growing time. Old failures are forgotten after `decayMs` of quiet. */
export class LoginLimiter {
	private readonly entries = new Map<string, Entry>();
	private readonly free: number;
	private readonly baseMs: number;
	private readonly maxMs: number;
	private readonly decayMs: number;

	constructor(free: number, baseMs: number, maxMs: number, decayMs = 15 * 60 * 1000) {
		this.free = free;
		this.baseMs = baseMs;
		this.maxMs = maxMs;
		this.decayMs = decayMs;
	}

	/** Seconds to wait before the next attempt, or 0. */
	wait(key: string, now = Date.now()): number {
		const e = this.entries.get(key);
		return e && e.until > now ? Math.ceil((e.until - now) / 1000) : 0;
	}

	fail(key: string, now = Date.now()): void {
		const e = this.entries.get(key) ?? { fails: 0, until: 0, last: now };
		if (now - e.last > this.decayMs) e.fails = 0;
		e.fails++;
		e.last = now;
		if (e.fails >= this.free) e.until = now + Math.min(this.maxMs, this.baseMs * 2 ** (e.fails - this.free));
		this.entries.set(key, e);
		if (this.entries.size > 2000) this.prune(now);
	}

	/** Takes back one failure that was counted before the outcome was known. */
	refund(key: string, now = Date.now()): void {
		const e = this.entries.get(key);
		if (!e) return;
		e.fails = Math.max(0, e.fails - 1);
		if (e.fails < this.free) e.until = 0;
		if (e.fails === 0 && e.until <= now) this.entries.delete(key);
	}

	reset(key: string): void {
		this.entries.delete(key);
	}

	private prune(now: number): void {
		for (const [k, e] of this.entries) if (e.until <= now && now - e.last > 60 * 60 * 1000) this.entries.delete(k);
	}
}

// ---------- hosts ----------

/** Host header without port or IPv6 brackets, lower-cased, trailing dot removed. */
export function hostnameOf(hostHeader: string | undefined): string {
	if (!hostHeader) return "";
	let h = hostHeader.trim().toLowerCase();
	if (h.startsWith("[")) h = h.slice(1, Math.max(h.indexOf("]"), 1));
	else h = h.split(":")[0] ?? "";
	return h.endsWith(".") ? h.slice(0, -1) : h;
}

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOST_PATTERN = new RegExp(`^(\\*\\.)?${LABEL}(\\.${LABEL})*$`);

/** Validates the allow-list the user typed: `example.com` or `*.example.com`; a port is ignored. */
export function normalizeHosts(input: unknown): string[] {
	if (!Array.isArray(input)) throw new Error("域名白名单格式不正确");
	const out = new Set<string>();
	for (const raw of input) {
		if (typeof raw !== "string") throw new Error("域名白名单格式不正确");
		let h = raw.trim().toLowerCase().replace(/:\d{1,5}$/, "");
		if (h.endsWith(".")) h = h.slice(0, -1);
		if (!h) continue;
		if (h.length > 253 || !HOST_PATTERN.test(h) || h === "*" || isIP(h)) throw new Error(`域名格式不正确：${raw.trim()}（只填域名，如 example.com 或 *.example.com）`);
		out.add(h);
	}
	if (out.size > MAX_HOSTS) throw new Error(`域名最多 ${MAX_HOSTS} 个`);
	return [...out];
}

/** Whether `name` matches an entry of the user's list (exact, or `*.domain` for any subdomain). */
function listed(name: string, allowed: readonly string[]): boolean {
	return allowed.some((p) => (p.startsWith("*.") ? name.length > p.length - 1 && name.endsWith(p.slice(1)) : name === p));
}

/**
 * Whether the network listener may answer a request for this Host. IP addresses and `localhost`
 * always pass (they cannot be used for DNS rebinding); any other name must be on the list.
 */
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
	const name = hostnameOf(hostHeader);
	if (!name) return false;
	if (isIP(name) || name === "localhost") return true;
	return listed(name, allowed);
}

/**
 * Host check plus a same-origin check for browser requests. An Origin passes when it is the Host
 * itself, one of the listed domains (a proxy that does not forward Host still works), or the desktop app.
 */
export function networkRequestAllowed(req: Pick<IncomingMessage, "headers">, allowed: readonly string[], extraOrigins: ReadonlySet<string> = new Set()): boolean {
	const host = req.headers.host;
	if (!hostAllowed(host, allowed)) return false;
	const origin = req.headers.origin;
	// Non-browser clients (CLI, native apps) send no Origin.
	if (!origin) return true;
	if (TAURI_ORIGINS.has(origin) || extraOrigins.has(origin)) return true;
	try {
		const url = new URL(origin);
		return url.host.toLowerCase() === (host ?? "").toLowerCase() || listed(url.hostname.toLowerCase(), allowed);
	} catch {
		return false;
	}
}

// ---------- who is local ----------

const FORWARD_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-server", "x-real-ip", "via"];

/** A reverse proxy in front of us leaves these; a request carrying them did not come from this machine's user. */
export function isForwarded(req: Pick<IncomingMessage, "headers">): boolean {
	return FORWARD_HEADERS.some((h) => req.headers[h] !== undefined);
}

export function isLoopbackSocket(address: string | undefined): boolean {
	if (!address) return false;
	const a = address.startsWith("::ffff:") ? address.slice(7) : address;
	return a === "::1" || a.startsWith("127.");
}

export type AuthMode = "none" | "token" | "password" | "deny";
export interface Access {
	mode: AuthMode;
	/** Same machine, no proxy in between: may change network settings. */
	local: boolean;
}

export interface AccessInput {
	listener: "main" | "network";
	tokenSet: boolean;
	/** HOST is non-loopback: the token is the only credential and the network settings are off. */
	managed: boolean;
	passwordSet: boolean;
	forwarded: boolean;
	loopbackSocket: boolean;
}

/**
 * The one place that decides who must sign in. The network listener always asks for the password,
 * even from loopback, so a proxy on this machine cannot turn into a free pass. The main listener
 * trusts only a direct loopback connection; anything that arrives through a proxy is a stranger.
 */
export function accessFor(i: AccessInput): Access {
	if (i.listener === "network") return { mode: i.passwordSet ? "password" : "deny", local: false };
	if (i.tokenSet && i.managed) return { mode: "token", local: i.loopbackSocket && !i.forwarded };
	if (i.forwarded) return { mode: i.passwordSet ? "password" : "deny", local: false };
	if (i.tokenSet) return { mode: "token", local: i.loopbackSocket };
	return { mode: "none", local: i.loopbackSocket };
}

/** IPv4 addresses of this machine that other devices on the network can use. */
export function lanAddresses(): string[] {
	const out: string[] = [];
	for (const list of Object.values(networkInterfaces())) {
		for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
	}
	return out;
}
