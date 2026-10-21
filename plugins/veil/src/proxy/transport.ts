/**
 * Outbound proxy plumbing built on `node:http` / `node:https`, with no third-party dependency
 * (a Prometheus plugin may only import Node built-ins).
 *
 * Two shapes are needed:
 *  - `http-proxy`: a plain `CONNECT` tunnel to the proxy, then TLS to the origin.
 *  - `socks5`: a SOCKS5 handshake (RFC 1928 + 1929 user/pass) then TLS to the origin.
 *
 * `https-proxy` is handled as `http-proxy` because every mainstream HTTPS proxy also answers
 * `CONNECT` on its TLS listener.
 */
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { connect as netConnect, Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

export type ProxyKind = "none" | "http" | "socks5";

export interface ProxySettings {
	kind: ProxyKind;
	/** `host:port`, without scheme. */
	server: string;
	username?: string;
	password?: string;
}

export interface ProxyTarget {
	host: string;
	port: number;
}

/** Parses `http://user:pass@host:port` / `socks5://host:port` into settings. Throws on bad input. */
export function parseProxyUrl(raw: string): ProxySettings {
	const trimmed = raw.trim();
	if (!trimmed) return { kind: "none", server: "" };
	const withScheme = /^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`代理地址无法解析：${raw}`);
	}
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	const kind: ProxyKind = scheme === "socks5" || scheme === "socks5h" || scheme === "socks" ? "socks5" : scheme === "http" || scheme === "https" ? "http" : "none";
	if (kind === "none") throw new Error(`不支持的代理协议：${scheme}（支持 http、https、socks5）`);
	const port = url.port ? Number(url.port) : kind === "socks5" ? 1080 : 8080;
	if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`代理地址缺少有效的主机或端口：${raw}`);
	return {
		kind,
		server: `${url.hostname}:${port}`,
		...(url.username ? { username: decodeURIComponent(url.username) } : {}),
		...(url.password ? { password: decodeURIComponent(url.password) } : {}),
	};
}

/** Render settings back to a URL, masking the password for display. */
export function formatProxyUrl(p: ProxySettings, mask = false): string {
	if (p.kind === "none" || !p.server) return "";
	const scheme = p.kind === "socks5" ? "socks5" : "http";
	const auth = p.username ? `${encodeURIComponent(p.username)}${p.password ? `:${mask ? "••••" : encodeURIComponent(p.password)}` : ""}@` : "";
	return `${scheme}://${auth}${p.server}`;
}

function splitServer(server: string): ProxyTarget {
	const idx = server.lastIndexOf(":");
	if (idx === -1) return { host: server, port: 8080 };
	const port = Number(server.slice(idx + 1));
	return { host: server.slice(0, idx) || server, port: Number.isInteger(port) ? port : 8080 };
}

function connectRaw(target: ProxyTarget, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: target.host, port: target.port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`连接代理超时：${target.host}:${target.port}`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.setTimeout(0);
			resolve(socket);
		});
		socket.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** `CONNECT host:port HTTP/1.1`, then hand back the raw socket on the tunnel. */
async function httpTunnel(proxy: ProxySettings, destination: ProxyTarget, timeoutMs: number): Promise<Socket> {
	const p = splitServer(proxy.server);
	const socket = await connectRaw(p, timeoutMs);
	const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}\r\n` : "";
	const request = `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\nHost: ${destination.host}:${destination.port}\r\n${auth}\r\n`;

	return new Promise((resolve, reject) => {
		let buffered = "";
		const onData = (chunk: Buffer) => {
			buffered += chunk.toString("latin1");
			const end = buffered.indexOf("\r\n\r\n");
			if (end === -1) {
				if (buffered.length > 16 * 1024) fail(new Error("代理返回的响应头过长"));
				return;
			}
			cleanup();
			const statusLine = buffered.slice(0, buffered.indexOf("\r\n"));
			const status = Number(statusLine.split(" ")[1]);
			if (status !== 200) {
				socket.destroy();
				reject(new Error(`代理拒绝建立隧道（HTTP ${status}）：${statusLine}`));
				return;
			}
			// Anything after the header block was already origin data; push it back.
			const rest = Buffer.from(buffered.slice(end + 4), "latin1");
			if (rest.length > 0) socket.unshift(rest);
			resolve(socket);
		};
		const fail = (err: Error) => {
			cleanup();
			socket.destroy();
			reject(err);
		};
		const onError = (err: Error) => fail(err);
		const onClose = () => fail(new Error("代理在建立隧道时关闭了连接"));
		const timer = setTimeout(() => fail(new Error("代理建立隧道超时")), timeoutMs);
		function cleanup() {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
		}
		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("close", onClose);
		socket.write(request);
	});
}

/** SOCKS5 greeting + optional user/pass auth + CONNECT, per RFC 1928/1929. */
async function socksTunnel(proxy: ProxySettings, destination: ProxyTarget, timeoutMs: number): Promise<Socket> {
	const p = splitServer(proxy.server);
	const socket = await connectRaw(p, timeoutMs);
	socket.setNoDelay(true);

	const read = (): Promise<Buffer> =>
		new Promise((resolve, reject) => {
			const onData = (chunk: Buffer) => {
				cleanup();
				resolve(chunk);
			};
			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};
			const onClose = () => {
				cleanup();
				reject(new Error("SOCKS5 代理关闭了连接"));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("SOCKS5 代理响应超时"));
			}, timeoutMs);
			function cleanup() {
				clearTimeout(timer);
				socket.off("data", onData);
				socket.off("error", onError);
				socket.off("close", onClose);
			}
			socket.once("data", onData);
			socket.once("error", onError);
			socket.once("close", onClose);
		});

	/** Reads exactly `n` bytes, keeping leftovers for the next read. */
	let pending = Buffer.alloc(0);
	const readExact = async (n: number): Promise<Buffer> => {
		while (pending.length < n) {
			const more = await read();
			pending = Buffer.concat([pending, more]);
		}
		const out = pending.subarray(0, n);
		pending = pending.subarray(n);
		return Buffer.from(out);
	};

	try {
		const wantAuth = Boolean(proxy.username);
		socket.write(Buffer.from([0x05, wantAuth ? 2 : 1, wantAuth ? 0x02 : 0x00, ...(wantAuth ? [0x00] : [])]));
		const greeting = await readExact(2);
		if (greeting[0] !== 0x05) throw new Error("SOCKS5 代理返回了无效版本");
		const method = greeting[1];
		if (method === undefined) throw new Error("SOCKS5 代理返回了不完整的握手响应");
		if (method === 0xff) throw new Error("SOCKS5 代理不接受我们的认证方式");
		if (method === 0x02) {
			const user = Buffer.from(proxy.username ?? "", "utf8");
			const pass = Buffer.from(proxy.password ?? "", "utf8");
			if (user.length > 255 || pass.length > 255) throw new Error("SOCKS5 用户名或密码过长");
			socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
			const [, status] = await readExact(2);
			if (status !== 0x00) throw new Error("SOCKS5 认证失败");
		} else if (method !== 0x00) {
			throw new Error(`SOCKS5 代理要求不支持的认证方式：0x${method.toString(16)}`);
		}

		const host = Buffer.from(destination.host, "utf8");
		socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([(destination.port >> 8) & 0xff, destination.port & 0xff])]));

		const head = await readExact(4);
		if (head[0] !== 0x05) throw new Error("SOCKS5 代理返回了无效版本");
		if (head[1] !== 0x00) throw new Error(`SOCKS5 连接失败（原因码 0x${head[1]?.toString(16)}）`);
		const atyp = head[3];
		const addressLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await readExact(1))[0] : 0;
		if (!addressLength) throw new Error("SOCKS5 代理返回了未知的地址类型");
		await readExact(addressLength + 2);
		if (pending.length > 0) socket.unshift(pending);
		return socket;
	} catch (err) {
		socket.destroy();
		throw err;
	}
}

/** A socket already tunnelled to `destination` (still plaintext; the caller adds TLS if needed). */
export async function openTunnel(proxy: ProxySettings, destination: ProxyTarget, timeoutMs = 20_000): Promise<Socket> {
	if (proxy.kind === "socks5") return socksTunnel(proxy, destination, timeoutMs);
	return httpTunnel(proxy, destination, timeoutMs);
}

/**
 * A connection to `destination`, TLS-wrapped when `secure`. With no proxy this is a direct
 * connection that still honours `timeoutMs`.
 */
export function connectThrough(proxy: ProxySettings, destination: ProxyTarget, secure: boolean, servername?: string, timeoutMs = 20_000): Promise<Socket> {
	const tlsOptions: ConnectionOptions = {
		host: destination.host,
		port: destination.port,
		servername: servername ?? destination.host,
		ALPNProtocols: ["http/1.1"],
	} as ConnectionOptions;

	if (proxy.kind === "none") {
		if (!secure) return connectRaw(destination, timeoutMs);
		return new Promise((resolve, reject) => {
			const socket = tlsConnect({ ...tlsOptions, host: destination.host, port: destination.port });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`连接超时：${destination.host}:${destination.port}`));
			}, timeoutMs);
			socket.once("secureConnect", () => {
				clearTimeout(timer);
				resolve(socket);
			});
			socket.once("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
	}

	return openTunnel(proxy, destination, timeoutMs).then(
		(raw) =>
			new Promise<Socket>((resolve, reject) => {
				if (!secure) {
					resolve(raw);
					return;
				}
				const socket = tlsConnect({ ...tlsOptions, socket: raw });
				socket.once("secureConnect", () => resolve(socket));
				socket.once("error", (err) => {
					raw.destroy();
					reject(err);
				});
			}),
	);
}

/**
 * A `node:http` compatible agent that dials through the proxy.
 *
 * `Agent` accepts an asynchronous `callback(err, socket)` from `createConnection`; returning
 * nothing in that case is important — a placeholder socket would be treated as the live
 * connection and the request would fail with "Socket is closed".
 */
export function proxyAgent(proxy: ProxySettings, secure: boolean): HttpAgent {
	const agent = secure
		? new HttpsAgent({ keepAlive: true, maxSockets: 64 })
		: new HttpAgent({ keepAlive: true, maxSockets: 64 });

	const createConnection = (options: Record<string, unknown>, callback: (err: Error | null, socket?: Socket) => void): undefined => {
		const host = (options.hostname as string | undefined) ?? (options.host as string | undefined) ?? "localhost";
		const port = Number((options.port as number | string | undefined) ?? (secure ? 443 : 80));
		connectThrough(proxy, { host, port }, secure, host)
			.then((socket) => callback(null, socket))
			.catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err))));
		return undefined;
	};

	agent.createConnection = createConnection as unknown as typeof agent.createConnection;
	return agent;
}
