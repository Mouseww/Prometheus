import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RuntimeDriver } from "./driver.ts";
import { defaultServerEntry, createProcessDriver, type LaunchContext } from "./process-driver.ts";
import {
	buildWindowsAccountSetup,
	buildWindowsLaunchScript,
	type CommandLine,
	powershellArgs,
	tenantAccountName,
	WINDOWS_SECRETS_DIR,
	WINDOWS_SETUP_MARKER,
	wrapLinux,
	wrapMac,
} from "./sandbox-commands.ts";

export interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (line: CommandLine) => Promise<CommandResult>;

export const runCommand: CommandRunner = (line) =>
	new Promise((resolveResult) => {
		const child = spawn(line.command, line.args, { env: { ...process.env, ...line.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		child.on("error", (err) => resolveResult({ code: null, stdout, stderr: `${stderr}${err.message}` }));
		child.on("close", (code) => resolveResult({ code, stdout, stderr }));
	});

export interface SandboxDriverOptions {
	dataDir: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	entry?: string;
	nodePath?: string;
	repoRoot?: string;
	/** Tests: replaces process spawning for probes and Windows account setup. */
	run?: CommandRunner;
	/** Tests: replaces the marker and `/usr/bin/sandbox-exec` existence checks. */
	exists?: (path: string) => boolean;
	hubHome?: string;
	log?: (message: string) => void;
}

/** Thrown when Windows needs the one-time administrator setup (`pnpm hub:setup-sandbox`). */
export class AdminRequiredError extends Error {
	readonly code = "adminRequired";
	constructor(message = "Windows 沙箱需要管理员权限完成一次性设置，请以管理员身份运行 pnpm hub:setup-sandbox") {
		super(message);
		this.name = "AdminRequiredError";
	}
}

export const setupMarkerPath = (dataDir: string): string => join(dataDir, WINDOWS_SETUP_MARKER);

export function createSandboxDriver(options: SandboxDriverOptions): RuntimeDriver & { tail(userId: string): string } {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const run = options.run ?? runCommand;
	const exists = options.exists ?? existsSync;
	const entry = options.entry ?? (env.HUB_TENANT_ENTRY?.trim() || defaultServerEntry());
	const repoRoot = options.repoRoot ?? resolve(dirname(entry), "..", "..", "..");
	const log = options.log ?? (() => {});
	let availability: Promise<boolean> | undefined;
	let systemdRun: boolean | undefined;

	const probeLinux = async (): Promise<boolean> => {
		const r = await run({ command: "bwrap", args: ["--ro-bind", "/", "/", "--unshare-pid", "--unshare-ipc", "true"] });
		return r.code === 0;
	};

	const available = (): Promise<boolean> => {
		availability ??= (async () => {
			if (platform === "linux") return probeLinux();
			if (platform === "darwin") return exists("/usr/bin/sandbox-exec");
			if (platform === "win32") return exists(setupMarkerPath(options.dataDir));
			return false;
		})();
		return availability;
	};

	const ensureWindowsAccount = async (userId: string, root: string): Promise<{ account: string; secretFile: string }> => {
		const account = tenantAccountName(userId);
		const secretFile = join(options.dataDir, WINDOWS_SECRETS_DIR, `${account}.dpapi`);
		if (exists(secretFile)) return { account, secretFile };
		await mkdir(dirname(secretFile), { recursive: true });
		const password = `Pt-${randomBytes(18).toString("hex")}`;
		for (const line of buildWindowsAccountSetup({ account, root, secretFile, hubHome: options.hubHome ?? homedir() })) {
			const r = await run({ ...line, env: { ...line.env, PROM_T_PW: password } });
			const text = `${r.stdout}${r.stderr}`;
			const accessDenied = /access is denied|拒绝访问|error 5\b|系统错误 5/i.test(text);
			if (r.code !== 0 && !/already exists|已经存在/i.test(text)) {
				if (accessDenied) throw new AdminRequiredError();
				throw new Error(`创建租户账号失败 (${line.command} 退出码 ${String(r.code)}): ${text.trim().slice(0, 300)}`);
			}
		}
		log(`已创建租户本地账号 ${account}`);
		return { account, secretFile };
	};

	const wrap = async (ctx: LaunchContext): Promise<CommandLine> => {
		const { spec } = ctx;
		if (platform === "linux") {
			systemdRun ??= (await run({ command: "systemd-run", args: ["--user", "--scope", "--quiet", "true"] })).code === 0;
			if (!systemdRun) log("systemd-run 不可用，租户资源限制只记录不强制");
			const line = wrapLinux({
				nodePath: ctx.nodePath,
				repoRoot,
				root: spec.root,
				env: ctx.env,
				inner: ctx.inner,
				systemdRun,
				cpuLimit: spec.cpuLimit,
				memLimitMb: spec.memLimitMb,
			});
			return { ...line, env: { ...ctx.baseEnv, PATH: "/usr/local/bin:/usr/bin:/bin" } };
		}
		if (platform === "darwin") {
			const line = wrapMac({ nodePath: ctx.nodePath, repoRoot, root: spec.root, env: ctx.env, inner: ctx.inner });
			return { ...line, env: { ...ctx.baseEnv, ...ctx.env } };
		}
		if (platform === "win32") {
			if (!exists(setupMarkerPath(options.dataDir))) throw new AdminRequiredError();
			const { account, secretFile } = await ensureWindowsAccount(spec.userId, spec.root);
			const script = buildWindowsLaunchScript({
				account,
				secretFile,
				workDir: join(spec.root, "work"),
				logFile: join(spec.root, "data", "tenant.log"),
				memLimitMb: spec.memLimitMb,
				env: ctx.env,
				command: ctx.inner,
			});
			return { command: "powershell.exe", args: powershellArgs(script), env: ctx.baseEnv };
		}
		throw new Error(`当前平台不支持沙箱: ${platform}`);
	};

	return createProcessDriver({
		kind: "sandbox",
		entry,
		...(options.nodePath ? { nodePath: options.nodePath } : {}),
		env,
		platform,
		available,
		unavailableReason: () => (platform === "win32" ? "adminRequired" : platform === "linux" ? "需要安装 bubblewrap (bwrap) 并允许非特权用户命名空间" : platform === "darwin" ? "缺少 /usr/bin/sandbox-exec" : "平台不支持"),
		wrap,
	});
}
