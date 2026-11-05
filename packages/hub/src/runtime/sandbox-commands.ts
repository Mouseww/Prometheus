import { createHash } from "node:crypto";
import { dirname, join, posix, win32 } from "node:path";

/** A command line ready for `spawn`. */
export interface CommandLine {
	command: string;
	args: string[];
	/** Extra environment for the launcher itself (never for the tenant). */
	env?: Record<string, string>;
}

export interface SandboxPaths {
	/** Absolute path of the node binary. */
	nodePath: string;
	/** Repository root holding `apps/server`. Read-only inside the sandbox. */
	repoRoot: string;
	/** `<tenantRoot>/<userId>`. */
	root: string;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkEnv(env: Record<string, string>): void {
	for (const [k, v] of Object.entries(env)) {
		if (!ENV_KEY.test(k)) throw new Error(`环境变量名无效: ${k}`);
		if (v.includes("\0")) throw new Error(`环境变量 ${k} 含有空字符`);
	}
}

/** The directory that holds `bin/node` and `lib/node_modules` (two levels above the binary on Linux and macOS). */
export const nodePrefix = (nodePath: string): string => dirname(dirname(nodePath));

// ---------- Linux: bubblewrap ----------

export interface BwrapOptions extends SandboxPaths {
	env: Record<string, string>;
	/** Command and arguments to run inside, typically `[nodePath, ...nodeArgs, entry]`. */
	inner: string[];
}

/** Read-only system locations bound when they exist (`--ro-bind-try`). */
const LINUX_RO_TRY = ["/lib", "/lib64", "/bin", "/sbin", "/etc/ssl", "/etc/ca-certificates", "/etc/pki", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/localtime"];

export function buildBwrapArgs(o: BwrapOptions): string[] {
	checkEnv(o.env);
	const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--clearenv"];
	args.push("--ro-bind", "/usr", "/usr");
	for (const p of LINUX_RO_TRY) args.push("--ro-bind-try", p, p);
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	const prefix = nodePrefix(o.nodePath);
	if (!prefix.startsWith("/usr")) args.push("--ro-bind", prefix, prefix);
	args.push("--ro-bind", o.repoRoot, o.repoRoot);
	const data = posix.join(o.root, "data");
	const work = posix.join(o.root, "work");
	const policy = posix.join(o.root, "policy");
	args.push("--bind", data, data, "--bind", work, work, "--ro-bind", policy, policy);
	for (const [k, v] of Object.entries(o.env)) args.push("--setenv", k, v);
	args.push("--chdir", work, "--", ...o.inner);
	return args;
}

export interface LinuxWrapOptions extends BwrapOptions {
	/** Wrap in `systemd-run --user --scope` to enforce limits; false when it is missing. */
	systemdRun: boolean;
	cpuLimit: number;
	memLimitMb: number;
}

export function wrapLinux(o: LinuxWrapOptions): CommandLine {
	const bwrap = ["bwrap", ...buildBwrapArgs(o)];
	if (!o.systemdRun) return { command: bwrap[0] as string, args: bwrap.slice(1) };
	const limits = ["--user", "--scope", "--quiet", "-p", `MemoryMax=${Math.round(o.memLimitMb)}M`, "-p", `CPUQuota=${Math.round(o.cpuLimit * 100)}%`, "--"];
	return { command: "systemd-run", args: [...limits, ...bwrap] };
}

// ---------- macOS: sandbox-exec ----------

function sbString(path: string): string {
	if (/["\\\0]/.test(path)) throw new Error(`沙箱路径含有不支持的字符: ${path}`);
	return `"${path}"`;
}

export function buildMacProfile(o: SandboxPaths): string {
	const readable = ["/usr", "/System", "/Library", "/bin", "/sbin", "/private/etc", "/private/var/db", "/dev", "/etc", o.repoRoot, nodePrefix(o.nodePath)];
	const writable = [posix.join(o.root, "data"), posix.join(o.root, "work"), "/private/tmp", "/private/var/folders", "/dev"];
	return [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-exec)",
		"(allow signal (target self))",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix-shm)",
		"(allow network*)",
		`(allow file-read* ${readable.map((p) => `(subpath ${sbString(p)})`).join(" ")} (literal "/"))`,
		`(allow file-read* (subpath ${sbString(posix.join(o.root, "policy"))}))`,
		`(allow file-read* file-write* ${writable.map((p) => `(subpath ${sbString(p)})`).join(" ")})`,
	].join("\n");
}

export interface MacWrapOptions extends SandboxPaths {
	env: Record<string, string>;
	inner: string[];
}

/** `sandbox-exec` has no env flag: the launcher's own environment is the tenant's, so the caller passes `env` to spawn. */
export function wrapMac(o: MacWrapOptions): CommandLine {
	checkEnv(o.env);
	return { command: "/usr/bin/sandbox-exec", args: ["-p", buildMacProfile(o), ...o.inner] };
}

// ---------- Windows: low-privilege local account ----------

export const WINDOWS_TENANT_GROUP = "prometheus-tenants";
export const WINDOWS_SETUP_MARKER = "sandbox-setup.json";
export const WINDOWS_SECRETS_DIR = "tenants.secrets";

/** `prom_t_` + 8 hex characters: stable per user, within the 20 character limit of local account names. */
export const tenantAccountName = (userId: string): string => `prom_t_${createHash("sha256").update(userId).digest("hex").slice(0, 8)}`;

const CMD_UNSAFE = /["%&^|<>\r\n]/;

/** `cmd.exe /d /s /c "set "K=V" && ... && "node" args"`. Values that cmd would interpret are refused, never escaped. */
export function buildCmdLine(env: Record<string, string>, command: string[]): string {
	checkEnv(env);
	const sets = Object.entries(env).map(([k, v]) => {
		if (CMD_UNSAFE.test(v)) throw new Error(`环境变量 ${k} 含有 cmd.exe 无法安全传递的字符`);
		return `set "${k}=${v}"`;
	});
	const quoted = command.map((c) => {
		if (CMD_UNSAFE.test(c)) throw new Error(`命令参数含有 cmd.exe 无法安全传递的字符: ${c}`);
		return `"${c}"`;
	});
	return `/d /s /c "${[...sets, quoted.join(" ")].join(" && ")}"`;
}

const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

const JOB_CSHARP = `using System;
using System.Runtime.InteropServices;
public static class HubJob {
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
	[DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
	[DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
	[StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinWS; public UIntPtr MaxWS; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
	[StructLayout(LayoutKind.Sequential)] struct IOC { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
	[StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcess; public UIntPtr PeakJob; }
	static IntPtr job;
	public static bool Attach(IntPtr process, long memBytes) {
		job = CreateJobObject(IntPtr.Zero, null);
		EXT e = new EXT();
		e.Basic.LimitFlags = 0x2000u | (memBytes > 0 ? 0x200u : 0u);
		e.JobMemoryLimit = new UIntPtr((ulong)(memBytes > 0 ? memBytes : 0));
		int len = Marshal.SizeOf(typeof(EXT));
		IntPtr ptr = Marshal.AllocHGlobal(len);
		Marshal.StructureToPtr(e, ptr, false);
		bool ok = SetInformationJobObject(job, 9, ptr, (uint)len);
		return ok && AssignProcessToJobObject(job, process);
	}
}`;

export interface WindowsLaunchOptions {
	account: string;
	/** DPAPI-protected password (output of `ConvertFrom-SecureString`), readable by the Hub's own account only. */
	secretFile: string;
	workDir: string;
	logFile: string;
	memLimitMb: number;
	env: Record<string, string>;
	/** `[node.exe, ...nodeArgs, entry]` */
	command: string[];
}

/**
 * PowerShell that starts the tenant as the prepared account with `Start-Process -Credential`, puts it in a job object
 * (kill on close, memory cap) and waits. Killing the PowerShell process therefore ends the tenant.
 * Start-Process -Credential starts from the account's own environment, so the tenant's variables are set through `cmd /c set`.
 */
export function buildWindowsLaunchScript(o: WindowsLaunchOptions): string {
	const cmdArgs = buildCmdLine(o.env, o.command);
	return [
		"$ErrorActionPreference = 'Stop'",
		`$sec = (Get-Content -LiteralPath ${psQuote(o.secretFile)} -Raw).Trim() | ConvertTo-SecureString`,
		`$cred = New-Object System.Management.Automation.PSCredential(${psQuote(`.\\${o.account}`)}, $sec)`,
		`Add-Type -TypeDefinition @'\n${JOB_CSHARP}\n'@`,
		`$p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${psQuote(cmdArgs)} -Credential $cred -WorkingDirectory ${psQuote(o.workDir)} -WindowStyle Hidden -PassThru -RedirectStandardOutput ${psQuote(o.logFile)} -RedirectStandardError ${psQuote(`${o.logFile}.err`)}`,
		`$attached = [HubJob]::Attach($p.Handle, ${Math.max(0, Math.round(o.memLimitMb)) * 1024 * 1024})`,
		"if (-not $attached) { [Console]::Error.WriteLine('job object attach failed; memory limit and kill-on-close are not enforced') }",
		"$p.WaitForExit()",
		"exit $p.ExitCode",
	].join("\n");
}

/** `powershell.exe` arguments that run a script without any quoting concerns. */
export function powershellArgs(script: string): string[] {
	return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export interface WindowsAccountSetup {
	account: string;
	root: string;
	secretFile: string;
	/** Home directory of the Hub owner: the tenant account is explicitly denied read access to it. */
	hubHome: string | undefined;
}

/** Commands that create a tenant account, grant it its directory and store its password under DPAPI. Needs administrator rights. */
export function buildWindowsAccountSetup(o: WindowsAccountSetup): CommandLine[] {
	const win = (p: string): string => win32.normalize(p);
	const out: CommandLine[] = [
		// The password travels in the environment, not on a command line.
		{ command: "cmd.exe", args: ["/d", "/c", `net user ${o.account} %PROM_T_PW% /add /expires:never /passwordchg:no`] },
		{ command: "net", args: ["localgroup", WINDOWS_TENANT_GROUP, o.account, "/add"] },
		{ command: "icacls", args: [win(win32.join(o.root, "data")), "/grant", `${o.account}:(OI)(CI)F`, "/T", "/C", "/Q"] },
		{ command: "icacls", args: [win(win32.join(o.root, "work")), "/grant", `${o.account}:(OI)(CI)F`, "/T", "/C", "/Q"] },
		{ command: "icacls", args: [win(win32.join(o.root, "policy")), "/grant", `${o.account}:(OI)(CI)R`, "/T", "/C", "/Q"] },
	];
	if (o.hubHome) out.push({ command: "icacls", args: [win(o.hubHome), "/deny", `${o.account}:(OI)(CI)R`, "/C", "/Q"] });
	out.push({
		command: "powershell.exe",
		args: powershellArgs(
			`$s = ConvertTo-SecureString -String $env:PROM_T_PW -AsPlainText -Force; ConvertFrom-SecureString $s | Set-Content -LiteralPath ${psQuote(o.secretFile)} -Encoding ASCII`,
		),
	});
	return out;
}
