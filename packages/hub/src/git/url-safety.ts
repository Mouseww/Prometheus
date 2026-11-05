import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { badRequest } from "../errors.ts";

export interface RemoteUrlOptions {
	/** Tests only: accept local paths and file:// URLs and skip address checks. Never enabled by default. */
	allowLocal?: boolean;
	/** Upstream remotes are HTTPS only (spec 12.5 item 3); imports may also use ssh. */
	httpsOnly?: boolean;
	/** Resolver override (tests). */
	resolve?: (host: string) => Promise<string[]>;
}

const blocked = new BlockList();
for (const [net, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	blocked.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
	["2001:db8::", 32],
	["64:ff9b::", 96],
] as const) {
	blocked.addSubnet(net, bits, "ipv6");
}

/** True for loopback, private, link-local, unspecified, multicast and documentation ranges (v4, v6 and v4-mapped v6). */
export function isBlockedAddress(ip: string): boolean {
	const family = isIP(ip);
	if (family === 0) return true;
	return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

const SCP_LIKE = /^[A-Za-z0-9_][A-Za-z0-9._-]*@([A-Za-z0-9][A-Za-z0-9.-]*):(?!\/\/)[^\s]+$/;

const unsafe = (message: string) => badRequest(message, "unsafeUrl");

function hostOf(url: string, httpsOnly: boolean): string {
	if (/[\s\u0000-\u001f]/.test(url) || url.length > 2048) throw unsafe("远程地址无效");
	if (/^https:\/\//i.test(url) || (!httpsOnly && /^ssh:\/\//i.test(url))) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw unsafe("远程地址无效");
		}
		// ssh URLs carry a user name (git@host) but never a password; https URLs carry no credentials at all.
		if (parsed.password || (parsed.protocol === "https:" && parsed.username)) throw unsafe("远程地址不能包含凭据");
		if (!parsed.hostname) throw unsafe("远程地址缺少主机名");
		return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	}
	if (!httpsOnly) {
		const scp = SCP_LIKE.exec(url);
		if (scp) return (scp[1] as string).toLowerCase();
	}
	throw unsafe(httpsOnly ? "仅支持 https:// 远程地址" : "仅支持 https://、ssh:// 与 git@ 形式的远程地址");
}

/**
 * SSRF guard for admin-supplied remotes: scheme allow-list, no credentials, and every address the host resolves to must be public.
 * The check happens before git connects; a hostile DNS server could still rebind between the check and the connection, which is
 * why the clone and fetch run with a restricted protocol allow-list and a timeout.
 */
export async function assertSafeRemoteUrl(url: string, opts: RemoteUrlOptions = {}): Promise<void> {
	if (opts.allowLocal && !url.startsWith("-")) return;
	const host = hostOf(url, opts.httpsOnly === true);
	if (host === "localhost" || host.endsWith(".localhost")) throw unsafe("不允许访问本机或内网地址");
	if (isIP(host)) {
		if (isBlockedAddress(host)) throw unsafe("不允许访问本机或内网地址");
		return;
	}
	let addresses: string[];
	try {
		addresses = opts.resolve ? await opts.resolve(host) : (await lookup(host, { all: true })).map((a) => a.address);
	} catch {
		throw unsafe("无法解析远程主机");
	}
	if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw unsafe("不允许访问本机或内网地址");
}
