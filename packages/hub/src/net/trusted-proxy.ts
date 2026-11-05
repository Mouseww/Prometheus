import { BlockList, isIP } from "node:net";

/** What `trustProxy` accepts: off, trust the immediate peer (one hop), or only these proxy addresses (IPs or CIDRs). */
export type TrustProxy = boolean | string[];

/** `1/true/on` -> true, empty/`0/false/off` -> false, otherwise a comma-separated list of IPs or CIDRs. Throws on an invalid entry. */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
	const value = (raw ?? "").trim();
	const lower = value.toLowerCase();
	if (lower === "" || ["0", "false", "off", "no"].includes(lower)) return false;
	if (["1", "true", "on", "yes"].includes(lower)) return true;
	const entries = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const entry of entries) {
		if (!parseEntry(entry)) throw new Error(`HUB_TRUST_PROXY 含有无效的地址或网段: ${entry}`);
	}
	return entries;
}

function parseEntry(entry: string): { address: string; prefix?: number; family: "ipv4" | "ipv6" } | undefined {
	const [address, prefixRaw, ...rest] = entry.split("/");
	if (!address || rest.length > 0) return undefined;
	const version = isIP(address);
	if (version === 0) return undefined;
	const family = version === 4 ? "ipv4" : "ipv6";
	if (prefixRaw === undefined) return { address, family };
	const prefix = Number(prefixRaw);
	const max = version === 4 ? 32 : 128;
	if (!/^\d+$/.test(prefixRaw) || prefix > max) return undefined;
	return { address, prefix, family };
}

/** `::ffff:1.2.3.4` -> `1.2.3.4`; other values are returned trimmed. */
export function normalizeIp(ip: string): string {
	const trimmed = ip.trim();
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
	return mapped?.[1] ?? trimmed;
}

/** Builds a matcher for a list of proxy IPs/CIDRs. */
export function proxyMatcher(entries: string[]): (ip: string) => boolean {
	const list = new BlockList();
	for (const entry of entries) {
		const parsed = parseEntry(entry);
		if (!parsed) continue;
		if (parsed.prefix === undefined) list.addAddress(parsed.address, parsed.family);
		else list.addSubnet(parsed.address, parsed.prefix, parsed.family);
	}
	return (ip) => {
		const normalized = normalizeIp(ip);
		const version = isIP(normalized);
		if (version === 0) return false;
		return list.check(normalized, version === 4 ? "ipv4" : "ipv6");
	};
}

/**
 * The client address of a request.
 * - off: the socket peer.
 * - true: the peer is a proxy we trust (one hop): the last X-Forwarded-For entry, which that proxy appended.
 * - list: only when the peer matches the list, walk X-Forwarded-For from the right and take the first address that is not itself a listed proxy.
 * Taking entries from the right means a client cannot choose its own address by sending a forged header.
 */
export function resolveClientIp(peer: string | undefined, forwardedFor: string | string[] | undefined, trust: TrustProxy): string {
	const socketIp = peer ? normalizeIp(peer) : "unknown";
	if (trust === false) return socketIp;
	const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : (forwardedFor ?? ""))
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (chain.length === 0) return socketIp;
	if (trust === true) return normalizeIp(chain[chain.length - 1] as string);
	const isProxy = proxyMatcher(trust);
	if (!peer || !isProxy(socketIp)) return socketIp;
	for (let i = chain.length - 1; i >= 0; i--) {
		const hop = normalizeIp(chain[i] as string);
		if (!isProxy(hop)) return hop;
	}
	return normalizeIp(chain[0] as string);
}
