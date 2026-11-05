import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

/** Where a Docker Engine listens. `unix` and `npipe` both go through `http.request({ socketPath })`. */
export type DockerEndpoint =
	| { kind: "socket"; path: string }
	| { kind: "tcp"; host: string; port: number; tls?: { ca: string; cert: string; key: string } | undefined };

export class DockerApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "DockerApiError";
		this.status = status;
	}
}

export const DEFAULT_UNIX_SOCKET = "/var/run/docker.sock";
export const WINDOWS_PIPES = ["//./pipe/docker_engine", "//./pipe/dockerDesktopLinuxEngine"] as const;

function loadTls(dir: string): { ca: string; cert: string; key: string } {
	return { ca: readFileSync(join(dir, "ca.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") };
}

/**
 * Parses a Docker URL (`DOCKER_HOST` style): `unix:///path`, `npipe:////./pipe/name`, `tcp://host:port`, `http(s)://host:port`.
 * A TLS directory (`DOCKER_CERT_PATH` or a node's `tls_dir`) turns a tcp endpoint into HTTPS with client certificates.
 */
export function parseDockerUrl(url: string, tlsDir?: string): DockerEndpoint {
	if (url.startsWith("unix://")) return { kind: "socket", path: url.slice("unix://".length) };
	if (url.startsWith("npipe://")) {
		const rest = url.slice("npipe://".length).replaceAll("\\", "/");
		return { kind: "socket", path: rest.startsWith("//") ? rest : `//${rest.replace(/^\/+/, "")}` };
	}
	const m = /^(tcp|http|https):\/\/([^/:]+|\[[^\]]+\])(?::(\d+))?\/?$/.exec(url);
	if (!m) throw new Error(`无法解析 Docker 地址: ${url}`);
	const scheme = m[1] as string;
	const host = (m[2] as string).replace(/^\[|\]$/g, "");
	const port = m[3] ? Number(m[3]) : scheme === "https" ? 2376 : 2375;
	const wantTls = scheme === "https" || Boolean(tlsDir);
	if (wantTls && !tlsDir) throw new Error(`Docker 地址 ${url} 使用 TLS，但没有提供证书目录`);
	return { kind: "tcp", host, port, tls: wantTls && tlsDir ? loadTls(tlsDir) : undefined };
}

/** Candidate endpoints for the local engine, best first: DOCKER_HOST, then the platform default(s). */
export function localEndpoints(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DockerEndpoint[] {
	const host = env.DOCKER_HOST?.trim();
	if (host) return [parseDockerUrl(host, env.DOCKER_CERT_PATH?.trim() || undefined)];
	if (platform === "win32") return WINDOWS_PIPES.map((path) => ({ kind: "socket" as const, path }));
	return [{ kind: "socket", path: DEFAULT_UNIX_SOCKET }];
}

export interface DockerClientOptions {
	endpoint: DockerEndpoint;
	/** Per-request timeout; pulls and stops use their own longer values. */
	timeoutMs?: number;
}

export interface DockerResponse {
	status: number;
	body: Buffer;
}

export interface DockerClient {
	readonly endpoint: DockerEndpoint;
	ping(): Promise<boolean>;
	imageExists(image: string): Promise<boolean>;
	pullImage(image: string): Promise<void>;
	createContainer(name: string, body: unknown): Promise<{ Id: string }>;
	startContainer(id: string): Promise<void>;
	stopContainer(id: string, timeoutSec?: number): Promise<void>;
	inspectContainer(id: string): Promise<DockerInspect | undefined>;
	containerStats(id: string): Promise<DockerStats>;
	removeContainer(id: string, force?: boolean): Promise<void>;
}

export interface DockerInspect {
	Id: string;
	State?: { Running?: boolean; Status?: string; ExitCode?: number };
	NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
}

export interface DockerStats {
	cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
	precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
	memory_stats?: { usage?: number; stats?: Record<string, number> };
}

/** Splits `name:tag` (a colon after the last slash is a tag, otherwise `latest`; a digest is kept whole). */
export function splitImage(image: string): { from: string; tag: string } {
	if (image.includes("@")) return { from: image, tag: "" };
	const slash = image.lastIndexOf("/");
	const colon = image.lastIndexOf(":");
	return colon > slash ? { from: image.slice(0, colon), tag: image.slice(colon + 1) } : { from: image, tag: "latest" };
}

export function createDockerClient(options: DockerClientOptions): DockerClient {
	const { endpoint } = options;
	const defaultTimeout = options.timeoutMs ?? 30_000;

	const send = (method: string, path: string, body?: unknown, timeoutMs = defaultTimeout): Promise<DockerResponse> =>
		new Promise<DockerResponse>((resolve, reject) => {
			const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
			const headers: Record<string, string | number> = { host: "docker", accept: "application/json" };
			if (payload) {
				headers["content-type"] = "application/json";
				headers["content-length"] = payload.length;
			}
			const base: RequestOptions = { method, path, headers, timeout: timeoutMs };
			const onResponse = (res: IncomingMessage): void => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
				res.on("error", reject);
			};
			const req =
				endpoint.kind === "socket"
					? httpRequest({ ...base, socketPath: endpoint.path }, onResponse)
					: endpoint.tls
						? httpsRequest({ ...base, host: endpoint.host, port: endpoint.port, ...endpoint.tls }, onResponse)
						: httpRequest({ ...base, host: endpoint.host, port: endpoint.port }, onResponse);
			req.on("timeout", () => req.destroy(new Error(`Docker 请求超时: ${method} ${path}`)));
			req.on("error", reject);
			req.end(payload);
		});

	const messageOf = (res: DockerResponse): string => {
		const text = res.body.toString("utf8").trim();
		try {
			const parsed = JSON.parse(text) as { message?: unknown };
			if (typeof parsed.message === "string") return parsed.message;
		} catch {
			// not JSON
		}
		return text || `HTTP ${res.status}`;
	};

	const expectOk = (res: DockerResponse, ok: readonly number[], what: string): void => {
		if (!ok.includes(res.status)) throw new DockerApiError(res.status, `${what}失败: ${messageOf(res)}`);
	};

	return {
		endpoint,
		async ping() {
			try {
				const res = await send("GET", "/_ping", undefined, 3000);
				return res.status === 200;
			} catch {
				return false;
			}
		},
		async imageExists(image) {
			const res = await send("GET", `/images/${image}/json`);
			if (res.status === 404) return false;
			expectOk(res, [200], "查询镜像");
			return true;
		},
		async pullImage(image) {
			const { from, tag } = splitImage(image);
			const q = new URLSearchParams({ fromImage: from });
			if (tag) q.set("tag", tag);
			const res = await send("POST", `/images/create?${q.toString()}`, undefined, 10 * 60_000);
			expectOk(res, [200], "拉取镜像");
			// The pull is a stream of JSON lines; an error mid-stream still arrives with status 200.
			for (const line of res.body.toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line) as { error?: string };
					if (msg.error) throw new DockerApiError(500, `拉取镜像失败: ${msg.error}`);
				} catch (err) {
					if (err instanceof DockerApiError) throw err;
				}
			}
		},
		async createContainer(name, body) {
			const res = await send("POST", `/containers/create?name=${encodeURIComponent(name)}`, body);
			expectOk(res, [201], "创建容器");
			return JSON.parse(res.body.toString("utf8")) as { Id: string };
		},
		async startContainer(id) {
			expectOk(await send("POST", `/containers/${id}/start`), [204, 304], "启动容器");
		},
		async stopContainer(id, timeoutSec = 10) {
			const res = await send("POST", `/containers/${id}/stop?t=${timeoutSec}`, undefined, (timeoutSec + 20) * 1000);
			if (res.status === 404) return;
			expectOk(res, [204, 304], "停止容器");
		},
		async inspectContainer(id) {
			const res = await send("GET", `/containers/${id}/json`);
			if (res.status === 404) return undefined;
			expectOk(res, [200], "查询容器");
			return JSON.parse(res.body.toString("utf8")) as DockerInspect;
		},
		async containerStats(id) {
			const res = await send("GET", `/containers/${id}/stats?stream=false`);
			expectOk(res, [200], "读取容器资源");
			return JSON.parse(res.body.toString("utf8")) as DockerStats;
		},
		async removeContainer(id, force = true) {
			const res = await send("DELETE", `/containers/${id}?force=${force ? "true" : "false"}&v=true`);
			if (res.status === 404) return;
			expectOk(res, [204], "删除容器");
		},
	};
}

/** CPU percent as Docker's CLI computes it (all cores = 100 * cores). */
export function cpuPercentOf(s: DockerStats): number | undefined {
	const cpu = s.cpu_stats?.cpu_usage?.total_usage;
	const preCpu = s.precpu_stats?.cpu_usage?.total_usage;
	const sys = s.cpu_stats?.system_cpu_usage;
	const preSys = s.precpu_stats?.system_cpu_usage;
	if (cpu === undefined || preCpu === undefined || sys === undefined || preSys === undefined) return undefined;
	const sysDelta = sys - preSys;
	const cpuDelta = cpu - preCpu;
	if (sysDelta <= 0 || cpuDelta < 0) return 0;
	return Math.round((cpuDelta / sysDelta) * (s.cpu_stats?.online_cpus ?? 1) * 10_000) / 100;
}

export function memMbOf(s: DockerStats): number | undefined {
	const usage = s.memory_stats?.usage;
	if (usage === undefined) return undefined;
	const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
	return Math.round(((usage - cache) / (1024 * 1024)) * 10) / 10;
}
