// Finding a Chromium-family browser on this machine and starting it with a private profile and a CDP pipe.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { CdpConnection, connectWebSocket } from "./cdp.ts";
import { GUEST_ARGS } from "./guest.ts";

export type BrowserKind = "custom" | "bundled" | "chrome" | "edge" | "chromium" | "brave";

export interface FoundBrowser {
	path: string;
	kind: BrowserKind;
}

function onPath(names: string[]): string | undefined {
	const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean);
	const exts = process.platform === "win32" ? ["", ".exe"] : [""];
	for (const name of names) for (const dir of dirs) for (const ext of exts) {
		const full = join(dir, name + ext);
		if (existsSync(full)) return full;
	}
	return undefined;
}

/** Installed browsers, best first: Chrome renders like most users' browser, Edge ships with every Windows. */
export function systemBrowsers(): FoundBrowser[] {
	const out: FoundBrowser[] = [];
	const add = (kind: BrowserKind, ...paths: (string | undefined)[]) => {
		for (const p of paths) if (p && existsSync(p) && !out.some((b) => b.path === p)) out.push({ path: p, kind });
	};
	if (process.platform === "win32") {
		const pf = process.env.ProgramFiles ?? "C:\\Program Files";
		const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
		add("chrome", join(pf, "Google\\Chrome\\Application\\chrome.exe"), join(pf86, "Google\\Chrome\\Application\\chrome.exe"), join(local, "Google\\Chrome\\Application\\chrome.exe"));
		add("edge", join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), join(pf, "Microsoft\\Edge\\Application\\msedge.exe"));
		add("brave", join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), join(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"));
		add("chromium", join(local, "Chromium\\Application\\chrome.exe"));
	} else if (process.platform === "darwin") {
		const apps = ["/Applications", join(homedir(), "Applications")];
		for (const dir of apps) {
			add("chrome", join(dir, "Google Chrome.app/Contents/MacOS/Google Chrome"));
			add("edge", join(dir, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"));
			add("chromium", join(dir, "Chromium.app/Contents/MacOS/Chromium"));
			add("brave", join(dir, "Brave Browser.app/Contents/MacOS/Brave Browser"));
		}
	} else {
		add("chrome", onPath(["google-chrome", "google-chrome-stable"]), "/opt/google/chrome/chrome");
		add("chromium", onPath(["chromium", "chromium-browser"]), "/usr/bin/chromium", "/snap/bin/chromium");
		add("edge", onPath(["microsoft-edge", "microsoft-edge-stable"]));
		add("brave", onPath(["brave-browser", "brave"]));
	}
	return out;
}

/** The executable to use: the configured one, then a browser downloaded by the plugin, then the system's. */
export function locateBrowser(customPath: string, bundledPath: string | undefined): FoundBrowser | undefined {
	if (customPath) return existsSync(customPath) ? { path: customPath, kind: "custom" } : undefined;
	if (bundledPath && existsSync(bundledPath)) return { path: bundledPath, kind: "bundled" };
	return systemBrowsers()[0];
}

export interface LaunchOptions {
	executable: string;
	profileDir: string;
	headless: boolean;
	/** http://host:port, socks5://host:port; empty for a direct connection. */
	proxy: string;
	lang: string;
	window: { width: number; height: number };
	/** Run inside the phone's PRoot rootfs through the runner (see guest.ts); implies the WebSocket transport. */
	guest?: { runner: string; cwd: string };
	/** "pipe" (default) keeps the browser unreachable for other processes; "ws" listens on a random loopback port. */
	transport?: "pipe" | "ws";
	onExit?: (code: number | null, stderr: string) => void;
}

const usesWs = (o: LaunchOptions) => !!o.guest || o.transport === "ws";

export interface Launched {
	proc: ChildProcess;
	conn: CdpConnection;
	userAgent: string;
	product: string;
}

export function launchArgs(o: LaunchOptions): string[] {
	const args = [
		usesWs(o) ? "--remote-debugging-port=0" : "--remote-debugging-pipe",
		`--user-data-dir=${o.profileDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-default-apps",
		"--disable-sync",
		"--disable-component-extensions-with-background-pages",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-ipc-flooding-protection",
		"--disable-hang-monitor",
		"--disable-popup-blocking",
		"--disable-prompt-on-repost",
		"--disable-client-side-phishing-detection",
		"--hide-crash-restore-bubble",
		"--metrics-recording-only",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,HeadlessHideScrollbars,msEdgeSidebarV2,msUndersideButton",
		`--lang=${o.lang}`,
		`--window-size=${o.window.width},${o.window.height}`,
	];
	// chrome-headless-shell (the phone's browser) is headless by itself and does not take --headless=new.
	if (o.headless) args.push(...(o.guest ? ["--mute-audio"] : ["--headless=new", "--mute-audio"]));
	if (o.guest) args.push(...GUEST_ARGS);
	if (o.proxy) args.push(`--proxy-server=${o.proxy}`);
	if (process.platform === "linux") args.push("--password-store=basic");
	if (process.platform === "darwin") args.push("--use-mock-keychain");
	// Chromium refuses to sandbox as root (containers); it would not start at all otherwise.
	if (!o.guest && process.platform === "linux" && process.getuid?.() === 0) args.push("--no-sandbox");
	args.push("about:blank");
	return args;
}

const PID_FILE = "browser.pid";

function groupKill(proc: ChildProcess): void {
	if (!proc.pid) return;
	try {
		if (process.platform === "win32") proc.kill();
		else process.kill(-proc.pid, "SIGKILL");
	} catch {
		try {
			proc.kill("SIGKILL");
		} catch {}
	}
}

async function waitEndpoint(file: string, timeoutMs: number): Promise<string> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const [port, path] = (await readFile(file, "utf8").catch(() => "")).split("\n");
		if (port && path && /^\d+$/.test(port.trim())) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error("浏览器没有在限定时间内就绪");
}

/**
 * A browser left over from a crashed server still holds the profile; a new one with the same profile would hand its
 * command line to the old process and exit. Ends the one we started last time, if it is still there.
 */
async function endStale(dataDir: string): Promise<void> {
	const file = join(dataDir, PID_FILE);
	const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, 0);
	} catch {
		await rm(file, { force: true });
		return;
	}
	try {
		if (process.platform === "win32") {
			await new Promise<void>((done) => {
				const p = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				p.on("exit", () => done());
				p.on("error", () => done());
			});
		} else {
			// The browser leads its own process group (detached), so its helper processes go with it.
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				process.kill(pid, "SIGKILL");
			}
		}
	} catch {
		// Already gone, or not ours to end.
	}
	await new Promise((r) => setTimeout(r, 300));
	await rm(file, { force: true });
}

export async function launchBrowser(o: LaunchOptions, dataDir: string, timeoutMs = 30_000): Promise<Launched> {
	await mkdir(o.profileDir, { recursive: true });
	await endStale(dataDir);
	const ws = usesWs(o);
	const activePort = join(o.profileDir, "DevToolsActivePort");
	if (ws) await rm(activePort, { force: true });
	const [command, argv, cwd] = o.guest ? [o.guest.runner, [o.executable, ...launchArgs(o)], o.guest.cwd] : [o.executable, launchArgs(o), undefined];
	const proc = spawn(command, argv, {
		stdio: ws ? ["ignore", "ignore", "pipe"] : ["ignore", "ignore", "pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
		...(cwd ? { cwd } : {}),
	});
	let stderr = "";
	proc.stderr?.on("data", (d: Buffer) => {
		if (stderr.length < 16_000) stderr += d.toString("utf8");
	});
	let conn: CdpConnection = ws ? new CdpConnection(new PassThrough(), new PassThrough()) : new CdpConnection(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
	const exited = new Promise<never>((_, reject) => {
		proc.once("error", (e) => reject(e));
		proc.once("exit", (code) => reject(new Error(`浏览器启动后立即退出（代码 ${code}）${stderr ? `：${stderr.trim().split("\n").slice(-3).join(" ")}` : "。配置目录可能被另一个浏览器进程占用。"}`)));
	});
	proc.once("exit", (code) => {
		conn.shutdown(`browser exited (${code})`);
		if (ws) groupKill(proc);
		void rm(join(dataDir, PID_FILE), { force: true }).catch(() => {});
		o.onExit?.(code, stderr);
	});
	try {
		if (ws) {
			// The browser writes the port and the secret socket path of its endpoint here once it listens.
			const target = await Promise.race([waitEndpoint(activePort, timeoutMs), exited]);
			conn.shutdown("replaced");
			conn = await Promise.race([connectWebSocket(target), exited]);
		}
		const version = await Promise.race([
			conn.send<{ product: string; userAgent: string }>("Browser.getVersion", {}, undefined, timeoutMs),
			exited,
		]);
		if (proc.pid) await writeFile(join(dataDir, PID_FILE), String(proc.pid)).catch(() => {});
		return { proc, conn, userAgent: version.userAgent, product: version.product };
	} catch (err) {
		conn.shutdown("launch failed");
		groupKill(proc);
		throw err;
	}
}

/** Close politely, then make sure. */
export async function closeBrowser(l: Launched): Promise<void> {
	if (l.proc.exitCode !== null) return;
	const gone = new Promise<void>((done) => l.proc.once("exit", () => done()));
	await l.conn.send("Browser.close", {}, undefined, 3000).catch(() => {});
	const timer = setTimeout(() => groupKill(l.proc), 4000);
	await gone;
	clearTimeout(timer);
}
