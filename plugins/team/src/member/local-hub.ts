import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOG, TeamError } from "../types.ts";
import type { MemberEnv } from "./env.ts";

export const HUB_DEFAULT_PORT = 7421;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const READY_TIMEOUT_MS = 20_000;

export interface LocalHubStatus {
	running: boolean;
	ready?: boolean;
	pid?: number;
	host?: string;
	port?: number;
	/** Address to open in a browser on this machine. */
	url?: string;
	/** PROMETHEUS_TOKEN of the child: the owner needs it to open the Hub's own page. */
	token?: string;
	startedAt?: string;
}

export interface LocalHubOptions {
	execPath?: string;
	execArgv?: string[];
	/** The server entry file to start with `--role hub` (default: the entry of the running process). */
	entry?: string;
	home?: string;
	readyTimeoutMs?: number;
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** "I am the Hub": runs a second Prometheus server with `--role hub`, its own data folder and a random token, as a child process. */
export class LocalHub {
	private readonly env: MemberEnv;
	private readonly opts: LocalHubOptions;
	private child: ChildProcess | undefined;

	constructor(env: MemberEnv, opts: LocalHubOptions = {}) {
		this.env = env;
		this.opts = opts;
	}

	private async probe(host: string, port: number): Promise<boolean> {
		const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
		try {
			const res = await fetch(`http://${target.includes(":") ? `[${target}]` : target}:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
			return res.ok;
		} catch {
			return false;
		}
	}

	async status(): Promise<LocalHubStatus> {
		const hub = this.env.state.get().localHub;
		if (!hub) return { running: false };
		if (!alive(hub.pid)) {
			await this.env.state.update(({ localHub: _gone, ...rest }) => rest);
			return { running: false };
		}
		const target = hub.host === "0.0.0.0" ? "127.0.0.1" : hub.host;
		return { running: true, ready: await this.probe(hub.host, hub.port), pid: hub.pid, host: hub.host, port: hub.port, url: `http://${target}:${hub.port}`, token: hub.token, startedAt: hub.startedAt };
	}

	async start(params: Record<string, unknown>): Promise<LocalHubStatus> {
		const current = await this.status();
		if (current.running) return current;

		const lan = params.lan === true;
		const requestedHost = typeof params.host === "string" && params.host.trim() ? params.host.trim() : "127.0.0.1";
		if (!lan && !LOOPBACK.has(requestedHost)) throw new TeamError("lanNotConfirmed", "绑定到局域网地址需要明确确认 (lan: true)");
		const host = lan ? "0.0.0.0" : requestedHost;
		const port = typeof params.port === "number" && Number.isInteger(params.port) && params.port >= 1024 && params.port <= 65535 ? params.port : HUB_DEFAULT_PORT;
		const entry = this.opts.entry ?? process.argv[1];
		if (!entry) throw new TeamError("noEntry", "找不到当前服务入口，无法启动本地 Hub", 500);
		const token = randomBytes(24).toString("hex");

		const child = spawn(this.opts.execPath ?? process.execPath, [...(this.opts.execArgv ?? process.execArgv), entry, "--role", "hub"], {
			env: {
				...process.env,
				PROMETHEUS_HOME: join(this.opts.home ?? homedir(), ".prometheus-hub"),
				PROMETHEUS_TOKEN: token,
				PROMETHEUS_HOST: host,
				PROMETHEUS_PORT: String(port),
			},
			stdio: "ignore",
			detached: false,
			windowsHide: true,
		});
		this.child = child;
		let exited: number | null | undefined;
		child.once("exit", (code) => {
			exited = code ?? -1;
			if (this.child === child) this.child = undefined;
			void this.env.state
				.update((s) => {
					if (s.localHub?.pid !== child.pid) return s;
					const { localHub: _gone, ...rest } = s;
					return rest;
				})
				.catch(() => {});
		});
		const spawned = await new Promise<boolean>((resolve) => {
			child.once("spawn", () => resolve(true));
			child.once("error", () => resolve(false));
		});
		if (!spawned || child.pid === undefined) throw new TeamError("spawnFailed", `${LOG} 无法启动本地 Hub 进程`, 500);
		await this.env.state.update((s) => ({ ...s, localHub: { pid: child.pid as number, host, port, token, startedAt: new Date().toISOString() } }));

		const deadline = Date.now() + (this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
		while (Date.now() < deadline) {
			if (exited !== undefined) throw new TeamError("hubExited", `${LOG} 本地 Hub 启动后立即退出 (退出码 ${exited})，请检查端口 ${port} 是否被占用`, 500);
			if (await this.probe(host, port)) return this.status();
			await new Promise((r) => setTimeout(r, 300));
		}
		return this.status();
	}

	async stop(): Promise<LocalHubStatus> {
		const hub = this.env.state.get().localHub;
		if (this.child) this.child.kill();
		else if (hub && alive(hub.pid)) {
			try {
				process.kill(hub.pid);
			} catch {
				// Already gone.
			}
		}
		this.child = undefined;
		if (hub) await this.env.state.update(({ localHub: _gone, ...rest }) => rest);
		return { running: false };
	}

	/** On shutdown a Hub this process started goes down with it (it is not detached). */
	dispose(): void {
		this.child?.kill();
	}
}
