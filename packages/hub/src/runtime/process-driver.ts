import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { hostLayout, type RuntimeDriver, type RuntimeKind, type TenantHandle, type TenantSpec } from "./driver.ts";
import type { CommandLine } from "./sandbox-commands.ts";
import { join } from "node:path";

const TAIL_LINES = 40;
const STOP_GRACE_MS = 5000;

/** What a wrapper (bwrap, sandbox-exec, PowerShell) needs to build the final command line. */
export interface LaunchContext {
	spec: TenantSpec;
	port: number;
	nodePath: string;
	entry: string;
	/** `[nodePath, ...nodeArgs, entry]` */
	inner: string[];
	/** The tenant's full environment (spec.env plus the port). */
	env: Record<string, string>;
	/** A minimal environment for the launcher itself: never the Hub's own. */
	baseEnv: Record<string, string>;
}

export interface ProcessDriverOptions {
	kind: RuntimeKind;
	/** Server entry; defaults to `HUB_TENANT_ENTRY` or `apps/server/src/main.ts` of this repository. */
	entry?: string;
	nodePath?: string;
	available?: () => Promise<boolean>;
	unavailableReason?: () => string | undefined;
	/** Turns the plain command into a sandboxed one. Without it the tenant is a plain child process. */
	wrap?: (ctx: LaunchContext) => Promise<CommandLine> | CommandLine;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Tests: where the tenant's stdout goes (default: kept in a short tail buffer). */
	onOutput?: (userId: string, line: string) => void;
}

interface Running {
	child: ChildProcess;
	stopping: boolean;
	exited: boolean;
	waiters: ((code: number | null) => void)[];
	listeners: ((info: { code: number | null }) => void)[];
}

export const defaultServerEntry = (): string => fileURLToPath(new URL("../../../../apps/server/src/main.ts", import.meta.url));

/** Node before 22.18 only runs `.ts` files behind this flag. */
export function nodeArgsFor(version: string = process.versions.node): string[] {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	const stripsByDefault = major > 22 || (major === 22 && minor >= 18);
	return stripsByDefault ? [] : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
}

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => (port > 0 ? resolve(port) : reject(new Error("无法分配端口"))));
		});
	});
}

/** Minimal environment for a launcher or a plain tenant process. The Hub's own variables (keys, database URL) never pass through. */
export function minimalEnv(platform: NodeJS.Platform, source: NodeJS.ProcessEnv, home: string): Record<string, string> {
	const pick = (...names: string[]): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const n of names) {
			const key = Object.keys(source).find((k) => k.toLowerCase() === n.toLowerCase());
			const value = key ? source[key] : undefined;
			if (value) out[n] = value;
		}
		return out;
	};
	if (platform === "win32") return { ...pick("Path", "SystemRoot", "windir", "ComSpec", "PATHEXT"), TEMP: join(home, "tmp"), TMP: join(home, "tmp") };
	return { ...pick("PATH", "LANG", "LC_ALL"), TMPDIR: "/tmp" };
}

export function createProcessDriver(options: ProcessDriverOptions): RuntimeDriver & { tail(userId: string): string } {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const entry = options.entry ?? (env.HUB_TENANT_ENTRY?.trim() || defaultServerEntry());
	const nodePath = options.nodePath ?? process.execPath;
	const running = new Map<number, Running>();
	const tails = new Map<string, string[]>();

	const remember = (userId: string, chunk: Buffer): void => {
		const lines = tails.get(userId) ?? [];
		for (const line of chunk.toString("utf8").split(/\r?\n/)) {
			if (!line) continue;
			lines.push(line);
			options.onOutput?.(userId, line);
		}
		tails.set(userId, lines.slice(-TAIL_LINES));
	};

	const killTree = (pid: number, child: ChildProcess, signal: NodeJS.Signals): void => {
		if (platform === "win32") {
			spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill(signal));
			return;
		}
		child.kill(signal);
	};

	return {
		kind: options.kind,
		...(options.unavailableReason ? { unavailableReason: options.unavailableReason } : {}),
		available: options.available ?? (async () => true),
		tail: (userId) => (tails.get(userId) ?? []).join("\n"),
		async start(spec) {
			const port = await freePort();
			const tenantEnv = { ...spec.env, PROMETHEUS_PORT: String(port) };
			const layout = hostLayout(spec.root, join);
			const inner = [nodePath, ...nodeArgsFor(), entry];
			const baseEnv = minimalEnv(platform, env, layout.data);
			const ctx: LaunchContext = { spec, port, nodePath, entry, inner, env: tenantEnv, baseEnv };
			const line: CommandLine = options.wrap
				? await options.wrap(ctx)
				: { command: nodePath, args: [...inner.slice(1)], env: { ...baseEnv, ...tenantEnv } };
			tails.set(spec.userId, []);
			const child = spawn(line.command, line.args, {
				cwd: layout.work,
				env: line.env ?? baseEnv,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			child.stdout?.on("data", (c: Buffer) => remember(spec.userId, c));
			child.stderr?.on("data", (c: Buffer) => remember(spec.userId, c));
			const pid = await new Promise<number>((resolve, reject) => {
				child.once("error", reject);
				child.once("spawn", () => resolve(child.pid ?? 0));
			});
			const entryState: Running = { child, stopping: false, exited: false, waiters: [], listeners: [] };
			running.set(pid, entryState);
			child.on("exit", (code) => {
				entryState.exited = true;
				running.delete(pid);
				for (const w of entryState.waiters) w(code);
				if (!entryState.stopping) for (const l of entryState.listeners) l({ code });
			});
			const handle: TenantHandle = { userId: spec.userId, host: "127.0.0.1", port, pid };
			return handle;
		},
		async stop(handle) {
			const state = handle.pid === undefined ? undefined : running.get(handle.pid);
			if (!state || handle.pid === undefined) return;
			state.stopping = true;
			const done = new Promise<void>((resolve) => state.waiters.push(() => resolve()));
			killTree(handle.pid, state.child, "SIGTERM");
			const timer = setTimeout(() => killTree(handle.pid as number, state.child, "SIGKILL"), STOP_GRACE_MS);
			timer.unref();
			await done;
			clearTimeout(timer);
		},
		async stats() {
			return {};
		},
		onExit(handle, cb) {
			const state = handle.pid === undefined ? undefined : running.get(handle.pid);
			if (state) state.listeners.push(cb);
		},
	};
}
