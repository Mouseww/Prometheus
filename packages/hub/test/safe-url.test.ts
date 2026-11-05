import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyAddress, parseIPv6, pinnedLookup, pinnedRequest, resolveSafeTarget, type SafeUrlPolicy } from "../src/net/safe-url.ts";

const pub: SafeUrlPolicy = { mode: "public", allowedPorts: [], blockPrivate: false };
const priv: SafeUrlPolicy = { mode: "private", allowedPorts: [], blockPrivate: false };
const withResolver = (policy: SafeUrlPolicy, ...addresses: string[]): SafeUrlPolicy => ({ ...policy, resolve: async () => addresses });

const rejects = async (url: string, policy: SafeUrlPolicy = pub): Promise<string> => {
	try {
		await resolveSafeTarget(url, policy);
	} catch (err) {
		expect((err as { code?: string }).code).toBe("unsafeUrl");
		return (err as Error).message;
	}
	throw new Error(`应当拒绝: ${url}`);
};

describe("address classification", () => {
	it.each([
		["127.0.0.1", "loopback"],
		["127.255.255.254", "loopback"],
		["10.0.0.1", "private"],
		["172.16.0.1", "private"],
		["172.31.255.255", "private"],
		["172.32.0.1", "public"],
		["192.168.0.1", "private"],
		["100.64.0.1", "private"],
		["100.127.255.255", "private"],
		["100.128.0.1", "public"],
		["169.254.169.254", "linkLocal"],
		["0.0.0.0", "unspecified"],
		["0.1.2.3", "unspecified"],
		["224.0.0.1", "multicast"],
		["255.255.255.255", "reserved"],
		["8.8.8.8", "public"],
		["::1", "loopback"],
		["::", "unspecified"],
		["fc00::1", "private"],
		["fd12:3456::1", "private"],
		["fe80::1", "linkLocal"],
		["febf::1", "linkLocal"],
		["ff02::1", "multicast"],
		["2606:4700:4700::1111", "public"],
		["::ffff:127.0.0.1", "loopback"],
		["::ffff:7f00:1", "loopback"],
		["::ffff:a00:1", "private"],
		["::ffff:8.8.8.8", "public"],
		["::127.0.0.1", "loopback"],
		["64:ff9b::a00:1", "private"],
		["2002:7f00:1::1", "loopback"],
		["2002:808:808::1", "public"],
	] as const)("%s is %s", (ip, expected) => {
		expect(classifyAddress(ip)).toBe(expected);
	});

	it("parses IPv6 text forms", () => {
		expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
		expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
		expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(parseIPv6("1::2::3")).toBeUndefined();
		expect(parseIPv6("zzzz::1")).toBeUndefined();
		expect(classifyAddress("not-an-ip")).toBe("reserved");
	});
});

describe("resolveSafeTarget in public mode", () => {
	it.each([
		"https://127.0.0.1/v1",
		"https://10.1.2.3/v1",
		"https://172.16.5.5/v1",
		"https://192.168.1.1/v1",
		"https://100.64.0.1/v1",
		"https://169.254.169.254/latest/meta-data",
		"https://0.0.0.0/",
		"https://[::1]/",
		"https://[::]/",
		"https://[fc00::1]/",
		"https://[fe80::1]/",
		"https://[::ffff:127.0.0.1]/",
		"https://[::ffff:7f00:1]/",
		"https://[::ffff:10.0.0.1]/",
		"https://[64:ff9b::7f00:1]/",
		"https://2130706433/",
		"https://0x7f.0.0.1/",
		"https://127.1/",
		"https://localhost/",
	])("rejects %s", async (url) => {
		await rejects(url, withResolver(pub, "127.0.0.1"));
	});

	it("rejects other protocols, credentials and bad URLs", async () => {
		expect(await rejects("http://8.8.8.8/")).toContain("https");
		await rejects("ftp://8.8.8.8/");
		await rejects("file:///etc/passwd");
		await rejects("https://user:pw@8.8.8.8/");
		await rejects("not a url");
		await rejects("");
		await rejects(`https://8.8.8.8/${"a".repeat(3000)}`);
	});

	it("accepts public literals and normalizes the target", async () => {
		const t = await resolveSafeTarget("https://8.8.8.8/v1/", pub);
		expect(t).toMatchObject({ hostname: "8.8.8.8", address: "8.8.8.8", family: 4, port: 443 });
		const v6 = await resolveSafeTarget("https://[2606:4700:4700::1111]/", pub);
		expect(v6).toMatchObject({ hostname: "2606:4700:4700::1111", family: 6 });
	});

	it("allows port 443 and the configured extra ports only", async () => {
		const policy = withResolver(pub, "93.184.216.34");
		await resolveSafeTarget("https://api.example.com/v1", policy);
		await resolveSafeTarget("https://api.example.com:443/v1", policy);
		expect(await rejects("https://api.example.com:8443/v1", policy)).toContain("8443");
		await rejects("https://api.example.com:22/", policy);
		await resolveSafeTarget("https://api.example.com:8443/v1", { ...policy, allowedPorts: [8443] });
	});

	it("rejects a host that resolves to a private address, even when only one of several does", async () => {
		await rejects("https://a.example.com/", withResolver(pub, "10.0.0.5"));
		await rejects("https://a.example.com/", withResolver(pub, "93.184.216.34", "10.0.0.5"));
		await rejects("https://a.example.com/", withResolver(pub, "93.184.216.34", "::1"));
		await rejects("https://a.example.com/", withResolver(pub, "::ffff:192.168.0.1"));
		await rejects("https://a.example.com/", withResolver(pub));
		await rejects("https://a.example.com/", {
			...pub,
			resolve: async () => {
				throw new Error("ENOTFOUND");
			},
		});
		const ok = await resolveSafeTarget("https://a.example.com/", withResolver(pub, "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"));
		expect(ok.address).toBe("93.184.216.34");
	});
});

describe("resolveSafeTarget in private mode", () => {
	it("allows http, any port, loopback and private ranges", async () => {
		await resolveSafeTarget("http://127.0.0.1:11434/v1", priv);
		await resolveSafeTarget("http://10.1.2.3:8000/v1", priv);
		await resolveSafeTarget("https://[fd00::5]:9443/", priv);
		await resolveSafeTarget("http://llm.corp.internal:8080/v1", withResolver(priv, "192.168.1.20"));
		await resolveSafeTarget("http://[::ffff:10.0.0.1]/", priv);
	});

	it("still refuses link-local (cloud metadata), unspecified and multicast addresses", async () => {
		await rejects("http://169.254.169.254/", priv);
		await rejects("http://[fe80::1]/", priv);
		await rejects("http://0.0.0.0/", priv);
		await rejects("http://224.0.0.1/", priv);
		await rejects("http://x.corp.internal/", withResolver(priv, "169.254.169.254"));
		await rejects("ftp://10.0.0.1/", priv);
	});

	it("HUB_BYOK_BLOCK_PRIVATE makes it as strict as public mode for addresses", async () => {
		const strict = { ...priv, blockPrivate: true };
		await rejects("http://127.0.0.1/", strict);
		await rejects("http://10.0.0.1/", strict);
		await resolveSafeTarget("http://8.8.8.8:8080/", strict);
	});
});

describe("pinned connection", () => {
	let server: Server;
	let port: number;
	const seenHosts: (string | undefined)[] = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			seenHosts.push(req.headers.host);
			if (req.url === "/redirect") {
				res.writeHead(302, { location: "http://127.0.0.1:1/other" });
				res.end();
			} else if (req.url === "/stream") {
				res.writeHead(200, { "content-type": "text/event-stream", "x-multi": "a" });
				res.write("data: 1\n\n");
				setTimeout(() => res.end("data: 2\n\n"), 10);
			} else if (req.url === "/nocontent") {
				res.writeHead(204);
				res.end();
			} else {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => {
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") }));
				});
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		port = (server.address() as AddressInfo).port;
	});
	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("pinnedLookup answers with the vetted address and never resolves the name", () => {
		const out: unknown[] = [];
		pinnedLookup("93.184.216.34", 4)("evil.example.com", {}, (err, address, family) => out.push(err, address, family));
		expect(out).toEqual([null, "93.184.216.34", 4]);
		let all: unknown;
		pinnedLookup("::1", 6)("evil.example.com", { all: true }, ((_e: unknown, a: unknown) => {
			all = a;
		}) as never);
		expect(all).toEqual([{ address: "::1", family: 6 }]);
	});

	it("DNS rebinding is defeated: the connection goes to the first, vetted answer", async () => {
		// The host name does not exist in real DNS, so a successful request proves the pinned address was used.
		let calls = 0;
		const policy: SafeUrlPolicy = {
			...priv,
			resolve: async () => {
				calls++;
				return calls === 1 ? ["127.0.0.1"] : ["203.0.113.9"];
			},
		};
		const target = await resolveSafeTarget(`http://rebind.byok-test.invalid:${port}/echo`, policy);
		const res = await pinnedRequest(target, { method: "POST", headers: new Headers({ authorization: "Bearer k", "content-type": "application/json" }), body: Buffer.from('{"a":1}') });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ method: "POST", auth: "Bearer k", body: '{"a":1}' });
		expect(calls).toBe(1);
		expect(seenHosts.at(-1)).toBe(`rebind.byok-test.invalid:${port}`);
	});

	it("refuses to follow a redirect to another host", async () => {
		const target = await resolveSafeTarget(`http://127.0.0.1:${port}/redirect`, priv);
		await expect(pinnedRequest(target, { method: "GET", headers: new Headers() })).rejects.toMatchObject({ status: 502, code: "upstreamRedirect" });
	});

	it("streams the body, keeps repeated headers and honours bodyless statuses", async () => {
		const stream = await pinnedRequest(await resolveSafeTarget(`http://127.0.0.1:${port}/stream`, priv), { method: "GET", headers: new Headers() });
		expect(stream.headers.get("content-type")).toBe("text/event-stream");
		expect(await stream.text()).toBe("data: 1\n\ndata: 2\n\n");
		const none = await pinnedRequest(await resolveSafeTarget(`http://127.0.0.1:${port}/nocontent`, priv), { method: "GET", headers: new Headers() });
		expect(none.status).toBe(204);
		expect(none.body).toBeNull();
	});

	it("aborts when the signal fires", async () => {
		const ac = new AbortController();
		const target = await resolveSafeTarget(`http://127.0.0.1:${port}/stream`, priv);
		const p = pinnedRequest(target, { method: "GET", headers: new Headers(), signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toBeTruthy();
	});
});
