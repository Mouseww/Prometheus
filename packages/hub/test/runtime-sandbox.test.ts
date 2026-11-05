import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostLayout, type RuntimeDriver } from "../src/runtime/driver.ts";
import { minimalEnv, nodeArgsFor } from "../src/runtime/process-driver.ts";
import {
	buildBwrapArgs,
	buildCmdLine,
	buildMacProfile,
	buildWindowsAccountSetup,
	buildWindowsLaunchScript,
	type CommandLine,
	powershellArgs,
	tenantAccountName,
	WINDOWS_SETUP_MARKER,
	WINDOWS_TENANT_GROUP,
	wrapLinux,
	wrapMac,
} from "../src/runtime/sandbox-commands.ts";
import { AdminRequiredError, type CommandRunner, createSandboxDriver, setupMarkerPath } from "../src/runtime/sandbox-driver.ts";
import { driverStatuses, parseRuntimeMode, selectDriver } from "../src/runtime/select.ts";

const paths = { nodePath: "/opt/node/bin/node", repoRoot: "/srv/prometheus", root: "/srv/tenants/u1" };

describe("bwrap (Linux)", () => {
	const args = buildBwrapArgs({ ...paths, env: { PROMETHEUS_HOME: "/srv/tenants/u1/data", A: "b c" }, inner: ["/opt/node/bin/node", "/srv/prometheus/apps/server/src/main.ts"] });

	it("isolates pid, ipc and the environment, and dies with the hub", () => {
		for (const flag of ["--die-with-parent", "--unshare-pid", "--unshare-ipc", "--clearenv", "--new-session"]) expect(args).toContain(flag);
		expect(args).not.toContain("--unshare-net");
	});

	it("binds system paths read-only, the repo and node read-only, tenant dirs writable", () => {
		const pairs = (flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));
		expect(pairs("--ro-bind")).toEqual(expect.arrayContaining(["/usr", "/srv/prometheus", "/opt/node", "/srv/tenants/u1/policy"]));
		expect(pairs("--bind")).toEqual(["/srv/tenants/u1/data", "/srv/tenants/u1/work"]);
		expect(pairs("--ro-bind-try")).toEqual(expect.arrayContaining(["/lib", "/lib64", "/bin", "/etc/ssl", "/etc/resolv.conf"]));
		expect(args).toContain("--tmpfs");
	});

	it("never binds the hub data dir or anything else of the host", () => {
		expect(args.join(" ")).not.toMatch(/hub|\/home|\/root/);
	});

	it("passes the tenant env with --setenv and ends with the inner command", () => {
		const i = args.indexOf("--setenv");
		expect(args.slice(i, i + 3)).toEqual(["--setenv", "PROMETHEUS_HOME", "/srv/tenants/u1/data"]);
		expect(args.slice(-5)).toEqual(["--chdir", "/srv/tenants/u1/work", "--", "/opt/node/bin/node", "/srv/prometheus/apps/server/src/main.ts"]);
	});

	it("skips the node bind when node lives under /usr", () => {
		const a = buildBwrapArgs({ ...paths, nodePath: "/usr/bin/node", env: {}, inner: ["node"] });
		expect(a.filter((x) => x === "/usr")).toHaveLength(2);
	});

	it("wraps in systemd-run for limits when available", () => {
		const base = { ...paths, env: {}, inner: ["node"], cpuLimit: 1.5, memLimitMb: 1024 };
		const withLimits = wrapLinux({ ...base, systemdRun: true });
		expect(withLimits.command).toBe("systemd-run");
		expect(withLimits.args.slice(0, 9)).toEqual(["--user", "--scope", "--quiet", "-p", "MemoryMax=1024M", "-p", "CPUQuota=150%", "--", "bwrap"]);
		const plain = wrapLinux({ ...base, systemdRun: false });
		expect(plain.command).toBe("bwrap");
	});

	it("refuses invalid environment names", () => {
		expect(() => buildBwrapArgs({ ...paths, env: { "A B": "x" }, inner: ["node"] })).toThrow("环境变量名无效");
	});
});

describe("sandbox-exec (macOS)", () => {
	const profile = buildMacProfile(paths);

	it("denies by default and opens only what the tenant needs", () => {
		expect(profile.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"]);
		expect(profile).toContain('(subpath "/srv/prometheus")');
		expect(profile).toMatch(/file-write\*.*\(subpath "\/srv\/tenants\/u1\/data"\).*\(subpath "\/srv\/tenants\/u1\/work"\)/);
		expect(profile).toContain("(allow network*)");
		expect(profile).not.toMatch(/file-write\*[^\n]*\/srv\/prometheus/);
		expect(profile).not.toMatch(/file-write\*[^\n]*policy/);
	});

	it("builds the command and rejects paths that could break out of the profile", () => {
		const line = wrapMac({ ...paths, env: {}, inner: ["/opt/node/bin/node", "main.ts"] });
		expect(line.command).toBe("/usr/bin/sandbox-exec");
		expect(line.args[0]).toBe("-p");
		expect(line.args.slice(2)).toEqual(["/opt/node/bin/node", "main.ts"]);
		expect(() => buildMacProfile({ ...paths, root: '/srv/x") (allow default' })).toThrow("不支持的字符");
	});
});

describe("Windows low-privilege account", () => {
	it("derives a stable short account name", () => {
		const a = tenantAccountName("01HXUSER");
		expect(a).toMatch(/^prom_t_[0-9a-f]{8}$/);
		expect(tenantAccountName("01HXUSER")).toBe(a);
		expect(tenantAccountName("other")).not.toBe(a);
		expect(a.length).toBeLessThanOrEqual(20);
	});

	it("builds a cmd line with set statements and refuses unsafe characters", () => {
		expect(buildCmdLine({ A: "1", B: "x y" }, ["C:\\node\\node.exe", "C:\\repo\\main.ts"])).toBe('/d /s /c "set "A=1" && set "B=x y" && "C:\\node\\node.exe" "C:\\repo\\main.ts""');
		expect(() => buildCmdLine({ A: "1&calc" }, ["x"])).toThrow("cmd.exe");
		expect(() => buildCmdLine({ A: "%PATH%" }, ["x"])).toThrow("cmd.exe");
		expect(() => buildCmdLine({}, ['x" & del'])).toThrow("cmd.exe");
	});

	const script = buildWindowsLaunchScript({
		account: "prom_t_abcd1234",
		secretFile: "C:\\hub\\tenants.secrets\\prom_t_abcd1234.dpapi",
		workDir: "C:\\t\\u1\\work",
		logFile: "C:\\t\\u1\\data\\tenant.log",
		memLimitMb: 512,
		env: { PROMETHEUS_PORT: "4000" },
		command: ["C:\\node.exe", "C:\\repo\\apps\\server\\src\\main.ts"],
	});

	it("starts the process as the tenant account from the DPAPI secret, inside a job object", () => {
		expect(script).toContain("ConvertTo-SecureString");
		expect(script).toContain("PSCredential('.\\prom_t_abcd1234'");
		expect(script).toContain("Start-Process -FilePath 'cmd.exe'");
		expect(script).toContain("-Credential $cred");
		expect(script).toContain("-WorkingDirectory 'C:\\t\\u1\\work'");
		expect(script).toContain("[HubJob]::Attach($p.Handle, 536870912)");
		expect(script).toContain("0x2000u");
		expect(script).not.toMatch(/password|-AsPlainText/i);
	});

	it("passes the script encoded, never inline", () => {
		const args = powershellArgs(script);
		expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
		expect(Buffer.from(args[5] as string, "base64").toString("utf16le")).toBe(script);
	});

	it("builds the account setup commands without putting the password on a command line", () => {
		const cmds = buildWindowsAccountSetup({ account: "prom_t_abcd1234", root: "C:\\t\\u1", secretFile: "C:\\hub\\s.dpapi", hubHome: "C:\\Users\\owner" });
		const flat = cmds.map((c) => `${c.command} ${c.args.join(" ")}`);
		expect(flat[0]).toContain("net user prom_t_abcd1234 %PROM_T_PW% /add");
		expect(flat.some((l) => l.startsWith("net localgroup prometheus-tenants prom_t_abcd1234 /add"))).toBe(true);
		expect(flat).toContainEqual(expect.stringContaining("icacls C:\\t\\u1\\data /grant prom_t_abcd1234:(OI)(CI)F"));
		expect(flat).toContainEqual(expect.stringContaining("icacls C:\\Users\\owner /deny prom_t_abcd1234:(OI)(CI)R"));
		expect(flat.join("\n")).not.toMatch(/Pt-/);
		const noHome = buildWindowsAccountSetup({ account: "a", root: "C:\\t", secretFile: "s", hubHome: undefined });
		expect(noHome.some((c) => c.args.includes("/deny"))).toBe(false);
	});
});

describe("sandbox driver availability", () => {
	const fakeRun = (okFor: (line: CommandLine) => boolean): CommandRunner => async (line) => ({ code: okFor(line) ? 0 : 1, stdout: "", stderr: "" });

	it("Linux needs a working bwrap", async () => {
		expect(await createSandboxDriver({ dataDir: "/d", platform: "linux", run: fakeRun((l) => l.command === "bwrap") }).available()).toBe(true);
		expect(await createSandboxDriver({ dataDir: "/d", platform: "linux", run: fakeRun(() => false) }).available()).toBe(false);
	});

	it("macOS needs /usr/bin/sandbox-exec", async () => {
		expect(await createSandboxDriver({ dataDir: "/d", platform: "darwin", exists: (p) => p === "/usr/bin/sandbox-exec" }).available()).toBe(true);
		expect(await createSandboxDriver({ dataDir: "/d", platform: "darwin", exists: () => false }).available()).toBe(false);
	});

	it("Windows needs the setup marker and otherwise says adminRequired", async () => {
		const dataDir = "C:\\hub";
		const ok = createSandboxDriver({ dataDir, platform: "win32", exists: (p) => p === setupMarkerPath(dataDir) });
		expect(await ok.available()).toBe(true);
		const missing = createSandboxDriver({ dataDir, platform: "win32", exists: () => false });
		expect(await missing.available()).toBe(false);
		expect(missing.unavailableReason?.()).toBe("adminRequired");
	});

	it("an unsupported platform is never available", async () => {
		expect(await createSandboxDriver({ dataDir: "/d", platform: "freebsd" }).available()).toBe(false);
	});

	it("Windows start without the marker throws adminRequired", async () => {
		const root = await mkdtemp(join(tmpdir(), "hub-sbx-"));
		const driver = createSandboxDriver({ dataDir: root, platform: "win32", exists: () => false });
		await mkdir(join(root, "work"), { recursive: true });
		await expect(driver.start({ userId: "u1", root, env: {}, cpuLimit: 1, memLimitMb: 256 })).rejects.toBeInstanceOf(AdminRequiredError);
	});
});

describe("setup scripts", () => {
	const read = (name: string): string => readFileSync(join(import.meta.dirname, "..", "..", "..", "scripts", name), "utf8");

	it("the Windows script uses the same group and marker names as the driver", () => {
		const ps = read("hub-setup-sandbox.ps1");
		expect(ps).toContain(`'${WINDOWS_TENANT_GROUP}'`);
		expect(ps).toContain(`'${WINDOWS_SETUP_MARKER}'`);
		expect(ps).toContain("/deny");
		expect(ps).toContain("IsInRole");
		expect(ps).toContain("New-LocalGroup");
		expect(setupMarkerPath("D:\\hub").replaceAll("\\", "/")).toMatch(/D:\/hub[\\/]sandbox-setup\.json$/);
	});

	it("the Linux script checks bwrap without changing anything", () => {
		const sh = read("hub-setup-sandbox.sh");
		expect(sh).toContain("command -v bwrap");
		expect(sh).toContain("bubblewrap");
		expect(sh).not.toMatch(/\bsudo (apt|dnf|pacman) (install|-S)\b[^"]*\n[^"]*&&/);
		expect(sh).not.toMatch(/^\s*(rm|mv|chmod|tee)\b/m);
	});
});

describe("launcher helpers", () => {
	it("adds the strip-types flag only on node older than 22.18", () => {
		expect(nodeArgsFor("22.17.0")).toContain("--experimental-strip-types");
		expect(nodeArgsFor("20.11.0")).toContain("--experimental-strip-types");
		expect(nodeArgsFor("22.18.0")).toEqual([]);
		expect(nodeArgsFor("24.1.0")).toEqual([]);
	});

	it("never passes the hub's environment to a tenant launcher", () => {
		const env = minimalEnv("linux", { PATH: "/usr/bin", HUB_SECRET_KEY: "s3cret", HUB_DATABASE_URL: "postgres://x", LANG: "C" }, "/data");
		expect(env).toEqual({ PATH: "/usr/bin", LANG: "C", TMPDIR: "/tmp" });
		const win = minimalEnv("win32", { Path: "C:\\Windows", SystemRoot: "C:\\Windows", HUB_SECRET_KEY: "s" }, "C:\\d");
		expect(win).toMatchObject({ Path: "C:\\Windows", SystemRoot: "C:\\Windows" });
		expect(JSON.stringify(win)).not.toContain("HUB_SECRET_KEY");
	});

	it("lays a tenant root out as data, work and policy", () => {
		expect(hostLayout("/r", join).policyFile).toBe(join("/r", "policy", "policy.json"));
	});
});

describe("driver selection", () => {
	const fake = (kind: RuntimeDriver["kind"], available: boolean, reason?: string): RuntimeDriver => ({
		kind,
		available: async () => available,
		...(reason ? { unavailableReason: () => reason } : {}),
		start: async () => ({ userId: "u", host: "h", port: 1 }),
		stop: async () => {},
		stats: async () => ({}),
	});

	it("auto prefers docker, then sandbox, then restricted", async () => {
		const all = (d: boolean, s: boolean): RuntimeDriver[] => [fake("restricted", true), fake("sandbox", s), fake("docker", d)];
		expect((await selectDriver("auto", all(true, true))).kind).toBe("docker");
		expect((await selectDriver("auto", all(false, true))).kind).toBe("sandbox");
		expect((await selectDriver("auto", all(false, false))).kind).toBe("restricted");
	});

	it("an explicit mode must be usable and is never silently downgraded", async () => {
		const drivers = [fake("docker", false), fake("sandbox", false, "adminRequired"), fake("restricted", true)];
		expect((await selectDriver("restricted", drivers)).kind).toBe("restricted");
		await expect(selectDriver("docker", drivers)).rejects.toMatchObject({ status: 503, code: "runtimeUnavailable" });
		await expect(selectDriver("sandbox", drivers)).rejects.toMatchObject({ status: 503, code: "adminRequired" });
	});

	it("fails when nothing is available", async () => {
		await expect(selectDriver("auto", [fake("docker", false)])).rejects.toMatchObject({ code: "runtimeUnavailable" });
	});

	it("parses HUB_RUNTIME", () => {
		expect(parseRuntimeMode(undefined)).toBe("auto");
		expect(parseRuntimeMode(" Docker ")).toBe("docker");
		expect(() => parseRuntimeMode("vm")).toThrow("HUB_RUNTIME 无效");
	});

	it("reports each driver's status with the reason", async () => {
		const s = await driverStatuses([fake("docker", true), fake("sandbox", false, "adminRequired")]);
		expect(s).toEqual([
			{ kind: "docker", available: true },
			{ kind: "sandbox", available: false, reason: "adminRequired" },
		]);
	});
});

const hasBwrap = process.platform === "linux" && spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "true"]).status === 0;

describe.skipIf(!hasBwrap)("bwrap (real)", () => {
	it("runs node inside the sandbox with only the tenant env", async () => {
		const root = await mkdtemp(join(tmpdir(), "hub-bwrap-"));
		for (const d of ["data", "work", "policy"]) await mkdir(join(root, d), { recursive: true });
		const line = wrapLinux({
			nodePath: process.execPath,
			repoRoot: process.cwd(),
			root,
			env: { PROMETHEUS_HOME: join(root, "data"), PATH: "/usr/bin:/bin" },
			inner: [process.execPath, "-e", "console.log(JSON.stringify({ home: process.env.PROMETHEUS_HOME, secret: process.env.HUB_SECRET_KEY ?? null }))"],
			systemdRun: false,
			cpuLimit: 1,
			memLimitMb: 256,
		});
		const r = spawnSync(line.command, line.args, { env: { PATH: process.env.PATH ?? "", HUB_SECRET_KEY: "leak" }, encoding: "utf8" });
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout.trim())).toEqual({ home: join(root, "data"), secret: null });
	});
});
