import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { badRequest, HubError } from "../errors.ts";

export type HubMode = "private" | "public";

/** Resolves a host name to every address it points at. Injected in tests; defaults to the system resolver. */
export type HostResolver = (host: string) => Promise<string[]>;

export interface SafeUrlPolicy {
	/** `public`: https only and only public addresses. `private`: http is allowed and intranet addresses are too (unless `blockPrivate`). */
	mode: HubMode;
	/** Ports allowed besides 443 in public mode (HUB_BYOK_ALLOWED_PORTS). Private mode allows any port. */
	allowedPorts: readonly number[];
	/** HUB_BYOK_BLOCK_PRIVATE=1: private mode behaves like public mode for addresses. */
	blockPrivate: boolean;
	resolve?: HostResolver;
}

/** A URL whose host has been resolved and vetted; `address` is the only IP the request may connect to. */
export interface SafeTarget {
	url: URL;
	/** Host name without IPv6 brackets. */
	hostname: string;
	address: string;
	family: 4 | 6;
	port: number;
}

export type AddressClass = "public" | "loopback" | "private" | "linkLocal" | "unspecified" | "multicast" | "reserved";

const unsafe = (message: string): HubError => badRequest(message, "unsafeUrl");

function parseIPv4(ip: string): number[] | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	const out: number[] = [];
	for (const p of parts) {
		if (!/^\d{1,3}$/.test(p)) return undefined;
		const n = Number(p);
		if (n > 255) return undefined;
		out.push(n);
	}
	return out;
}

/** Eight 16-bit groups of an IPv6 address (handles `::` and an embedded dotted quad); undefined when malformed. */
export function parseIPv6(input: string): number[] | undefined {
	let ip = input.toLowerCase();
	const zone = ip.indexOf("%");
	if (zone >= 0) ip = ip.slice(0, zone);
	if (!ip.includes(":")) return undefined;
	let tail: number[] = [];
	const lastColon = ip.lastIndexOf(":");
	const maybeV4 = ip.slice(lastColon + 1);
	if (maybeV4.includes(".")) {
		const v4 = parseIPv4(maybeV4);
		if (!v4) return undefined;
		tail = [((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number)];
		ip = `${ip.slice(0, lastColon + 1)}0:0`;
	}
	const halves = ip.split("::");
	if (halves.length > 2) return undefined;
	const parseGroups = (s: string): number[] | undefined => {
		if (s === "") return [];
		const out: number[] = [];
		for (const g of s.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
			out.push(Number.parseInt(g, 16));
		}
		return out;
	};
	const head = parseGroups(halves[0] as string);
	if (!head) return undefined;
	let groups: number[];
	if (halves.length === 2) {
		const rest = parseGroups(halves[1] as string);
		if (!rest) return undefined;
		const missing = 8 - head.length - rest.length;
		if (missing < 1) return undefined;
		groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
	} else {
		groups = head;
	}
	if (groups.length !== 8) return undefined;
	if (tail.length === 2) groups = [...groups.slice(0, 6), ...tail];
	return groups;
}

const dotted = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** The IPv4 address hidden inside an IPv6 one (v4-mapped, v4-compatible, NAT64 and 6to4), if any. */
function embeddedIPv4(g: number[]): string | undefined {
	const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
	if (zeros(0, 5) && g[5] === 0xffff) return dotted(g[6] as number, g[7] as number);
	if (zeros(0, 6) && (g[6] !== 0 || g[7] !== 0) && !(zeros(0, 7) && g[7] === 1)) return dotted(g[6] as number, g[7] as number);
	if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return dotted(g[6] as number, g[7] as number);
	if (g[0] === 0x2002) return dotted(g[1] as number, g[2] as number);
	return undefined;
}

const SEVERITY: AddressClass[] = ["public", "private", "loopback", "linkLocal", "reserved", "multicast", "unspecified"];
const worse = (a: AddressClass, b: AddressClass): AddressClass => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

function classifyV4(b: number[]): AddressClass {
	const [a, c, d] = b as [number, number, number, number];
	if (a === 0) return "unspecified";
	if (a === 127) return "loopback";
	if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127)) return "private";
	if (a === 169 && c === 254) return "linkLocal";
	if (a >= 224 && a <= 239) return "multicast";
	if (a >= 240) return "reserved";
	// IETF protocol assignments, documentation (TEST-NET 1 to 3) and benchmarking ranges.
	const documentation = (a === 192 && c === 0 && (d === 0 || d === 2)) || (a === 198 && c === 51 && d === 100) || (a === 203 && c === 0 && d === 113);
	if (documentation || (a === 198 && (c === 18 || c === 19))) return "reserved";
	return "public";
}

/** Classifies a literal IP address. Anything that is not a valid IP counts as `reserved`. */
export function classifyAddress(ip: string): AddressClass {
	const family = isIP(ip);
	if (family === 4) return classifyV4(parseIPv4(ip) as number[]);
	const g = parseIPv6(ip);
	if (!g) return "reserved";
	let result: AddressClass;
	if (g.every((x) => x === 0)) result = "unspecified";
	else if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) result = "loopback";
	else if (((g[0] as number) & 0xfe00) === 0xfc00) result = "private";
	else if (((g[0] as number) & 0xffc0) === 0xfe80) result = "linkLocal";
	else if (((g[0] as number) & 0xff00) === 0xff00) result = "multicast";
	else if (g[0] === 0x2001 && g[1] === 0xdb8) result = "reserved";
	else result = "public";
	const inner = embeddedIPv4(g);
	if (inner) result = worse(result, classifyV4(parseIPv4(inner) as number[]));
	return result;
}

function addressAllowed(cls: AddressClass, policy: SafeUrlPolicy): boolean {
	if (cls === "public") return true;
	if (policy.mode !== "private" || policy.blockPrivate) return false;
	// Intranet models are the point of private mode; link-local (cloud metadata), unspecified, multicast and reserved ranges never are.
	return cls === "loopback" || cls === "private";
}

const defaultResolver: HostResolver = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

function portOf(url: URL): number {
	if (url.port) return Number(url.port);
	return url.protocol === "https:" ? 443 : 80;
}

/**
 * Validates a user supplied upstream URL and resolves it once. Protocol, credentials, port and every resolved address are checked;
 * the returned `address` must be what the connection uses (see `pinnedRequest`), otherwise a rebinding DNS server could swap it.
 */
export async function resolveSafeTarget(raw: string, policy: SafeUrlPolicy): Promise<SafeTarget> {
	if (raw.length > 2048 || /[\s\u0000-\u001f]/.test(raw)) throw unsafe("地址无效");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw unsafe("地址不是有效的 URL");
	}
	const allowedProtocols = policy.mode === "private" ? ["https:", "http:"] : ["https:"];
	if (!allowedProtocols.includes(url.protocol)) throw unsafe(policy.mode === "private" ? "只支持 http 或 https 地址" : "只支持 https 地址");
	if (url.username || url.password) throw unsafe("地址不能包含用户名或密码");

	const port = portOf(url);
	if (policy.mode !== "private" && port !== 443 && !policy.allowedPorts.includes(port)) throw unsafe(`不允许使用端口 ${port}`);

	const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
	if (!hostname) throw unsafe("地址缺少主机名");

	let addresses: string[];
	if (isIP(hostname)) {
		addresses = [hostname];
	} else {
		try {
			addresses = await (policy.resolve ?? defaultResolver)(hostname);
		} catch {
			throw unsafe("无法解析主机名");
		}
	}
	if (addresses.length === 0) throw unsafe("无法解析主机名");
	for (const a of addresses) if (!addressAllowed(classifyAddress(a), policy)) throw unsafe("不允许访问本机或内网地址");
	const address = addresses[0] as string;
	return { url, hostname, address, family: isIP(address) === 6 ? 6 : 4, port };
}

/** A `lookup` callback that ignores the name and always answers with the vetted address. */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
	return (_hostname, options, callback) => {
		if (typeof options === "object" && options !== null && options.all) {
			(callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address, family }]);
		} else {
			callback(null, address, family);
		}
	};
}

export interface PinnedRequestInit {
	method: string;
	headers: Headers;
	body?: Buffer | undefined;
	signal?: AbortSignal | undefined;
}

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * One HTTP(S) request to a vetted target: connects to the pinned IP (the URL's host still drives SNI and the Host header),
 * never follows redirects (a 3xx is refused so a hostile server cannot bounce the Hub to another host) and returns a web Response.
 */
export function pinnedRequest(target: SafeTarget, init: PinnedRequestInit): Promise<Response> {
	const secure = target.url.protocol === "https:";
	const headers: Record<string, string> = {};
	init.headers.forEach((value, key) => {
		headers[key] = value;
	});
	if (init.body) headers["content-length"] = String(init.body.length);
	return new Promise<Response>((resolve, reject) => {
		const req = (secure ? httpsRequest : httpRequest)(
			{
				hostname: target.hostname,
				port: target.port,
				path: `${target.url.pathname}${target.url.search}`,
				method: init.method,
				headers,
				lookup: pinnedLookup(target.address, target.family),
				...(secure && !isIP(target.hostname) ? { servername: target.hostname } : {}),
				...(init.signal ? { signal: init.signal } : {}),
			},
			(res) => {
				const status = res.statusCode ?? 502;
				if (status >= 300 && status < 400 && status !== 304) {
					res.destroy();
					reject(new HubError(502, "upstreamRedirect", "上游服务返回了重定向，已拒绝跟随"));
					return;
				}
				const outHeaders = new Headers();
				for (const [k, v] of Object.entries(res.headers)) {
					if (v === undefined) continue;
					for (const item of Array.isArray(v) ? v : [v]) outHeaders.append(k, item);
				}
				const body = NO_BODY_STATUS.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
				if (body === null) res.resume();
				resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: outHeaders }));
			},
		);
		req.on("error", reject);
		req.end(init.body);
	});
}
