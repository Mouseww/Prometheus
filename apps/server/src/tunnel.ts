import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TunnelStatus } from "@prometheus/protocol";

const RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const URL_RE = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/gi;

/** A failure caused by reaching GitHub or Cloudflare; the UI tells the user to check the network and retry. */
class NetworkError extends Error {}

/** Proxy for downloads: env vars first, then the Windows system proxy. Node's own fetch ignores both. */
function proxyUrl(): string | undefined {
	const e = process.env;
	const env = e.HTTPS_PROXY ?? e.https_proxy ?? e.ALL_PROXY ?? e.all_proxy ?? e.HTTP_PROXY ?? e.http_proxy;
	if (env) return env;
	if (process.platform !== "win32") return undefined;
	const r = spawnSync("reg", ["query", String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, "/v", "ProxyServer"], { encoding: "utf8", windowsHide: true });
	const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(r.stdout ?? "");
	if (!m?.[1]) return undefined;
	const v = m[1].includes("=") ? (/https=([^;]+)/.exec(m[1])?.[1] ?? /http=([^;]+)/.exec(m[1])?.[1]) : m[1];
	return v ? (v.includes("://") ? v : `http://${v}`) : undefined;
}

/** Downloads with curl (ships with Windows 10+, macOS and most Linux), which honours the proxy. */
async function fetchFile(url: string, dest: string): Promise<void> {
	const proxy = proxyUrl();
	const args = ["-fL", "--retry", "2", "--connect-timeout", "20", "-o", dest, ...(proxy ? ["-x", proxy] : []), url];
	const r = spawnSync("curl", args, { encoding: "utf8", windowsHide: true });
	if (r.error) throw new Error("下载 cloudflared 需要 curl，请安装 curl 或手动安装 cloudflared 并加入 PATH");
	if (r.status !== 0) throw new NetworkError(`下载 cloudflared 失败${proxy ? `（代理 ${proxy}）` : "（未检测到代理）"}：${(r.stderr ?? "").trim().split("\n").pop() ?? ""}。可手动安装 cloudflared 并加入 PATH 后重试`);
}

/** Release asset for this OS/CPU, or null when Cloudflare publishes none. */
export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
	if (platform === "win32") return arch === "x64" ? "cloudflared-windows-amd64.exe" : arch === "ia32" ? "cloudflared-windows-386.exe" : null;
	if (platform === "linux") return arch === "x64" ? "cloudflared-linux-amd64" : arch === "arm64" ? "cloudflared-linux-arm64" : arch === "arm" ? "cloudflared-linux-arm" : null;
	if (platform === "darwin") return arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : arch === "x64" ? "cloudflared-darwin-amd64.tgz" : null;
	return null;
}

/**
 * A Cloudflare "quick tunnel": `cloudflared` dials out to Cloudflare and gets a random
 * https://xxxx.trycloudflare.com address that forwards to a local port. No account, domain,
 * port forwarding or DDNS needed. The binary is downloaded once into the data directory.
 */
export class QuickTunnel {
	private child: ChildProcess | undefined;
	private state: TunnelStatus = { state: "off" };
	private readonly binDir: string;
	private readonly onChange: () => void;

	constructor(dataDir: string, onChange: () => void = () => {}) {
		this.binDir = join(dataDir, "bin");
		this.onChange = onChange;
	}

	status(): TunnelStatus {
		return { ...this.state };
	}

	/** The public hostname while the tunnel is up; the network layer must let it through. */
	host(): string | undefined {
		return this.state.state === "on" && this.state.url ? new URL(this.state.url).hostname : undefined;
	}

	private set(next: TunnelStatus): void {
		this.state = next;
		this.onChange();
	}

	private localBinary(): string {
		return join(this.binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
	}

	private findBinary(): string | null {
		const local = this.localBinary();
		if (existsSync(local)) return local;
		const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["cloudflared"], { encoding: "utf8", windowsHide: true });
		const hit = probe.status === 0 ? probe.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined;
		return hit ? hit.trim() : null;
	}

	private async download(): Promise<string> {
		const asset = assetName();
		if (!asset) throw new Error(`Cloudflare 没有提供适用于 ${process.platform}/${process.arch} 的 cloudflared，请手动安装后重试`);
		await mkdir(this.binDir, { recursive: true });
		const target = this.localBinary();
		const tmp = `${target}.download`;
		const url = `${RELEASE}/${asset}`;
		const archive = asset.endsWith(".tgz") ? `${tmp}.tgz` : tmp;
		try {
			if (asset.endsWith(".tgz")) {
				await fetchFile(url, archive);
				const x = spawnSync("tar", ["-xzf", archive, "-C", this.binDir], { windowsHide: true });
				await rm(archive, { force: true });
				if (x.status !== 0) throw new Error("解压 cloudflared 失败");
			} else {
				await fetchFile(url, tmp);
				await rename(tmp, target);
			}
			if (process.platform !== "win32") await chmod(target, 0o755);
		} catch (err) {
			await rm(tmp, { force: true });
			throw err;
		}
		return target;
	}

	/** Returns at once; progress shows up through status(). Does nothing when already running. */
	start(port: number): void {
		if (this.state.state !== "off" && this.state.state !== "error") return;
		// Switch state before returning, so the status the caller gets back is never a stale "off" (the UI only polls while busy).
		this.set({ state: "starting" });
		void this.run(port).catch((err: unknown) => this.set({ state: "error", error: err instanceof Error ? err.message : String(err), ...(err instanceof NetworkError ? { network: true } : {}) }));
	}

	private async run(port: number): Promise<void> {
		let bin = this.findBinary();
		if (!bin) {
			if (this.state.state === "off") return;
			this.set({ state: "downloading" });
			bin = await this.download();
		}
		if (this.state.state === "off") return; // stopped while downloading
		this.set({ state: "starting" });
		const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		this.child = child;
		let tail = "";
		let pendingUrl: string | undefined;
		const onData = (chunk: Buffer): void => {
			const text = chunk.toString("utf8");
			tail = (tail + text).slice(-2000);
			// cloudflared also logs api.trycloudflare.com; the assigned address is any other match.
			const hit = [...text.matchAll(URL_RE)].find((m) => m[1]?.toLowerCase() !== "api.trycloudflare.com");
			if (hit) pendingUrl = `https://${hit[1]}`;
			// The address is printed several seconds before the tunnel is connected to Cloudflare's edge;
			// opening it earlier fails. Report "on" only once a connection is registered.
			if (pendingUrl && /Registered tunnel connection/i.test(tail) && this.child === child && this.state.state !== "on") this.set({ state: "on", url: pendingUrl });
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (err) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.set({ state: "error", error: err.message });
		});
		child.once("exit", (code) => {
			if (this.child !== child) return;
			this.child = undefined;
			const reason = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
			this.set({ state: "error", error: `cloudflared 已退出（${code ?? "signal"}）${reason ? `：${reason}` : ""}`, network: true });
		});
		setTimeout(() => {
			if (this.child === child && this.state.state === "starting") {
				this.stop();
				this.set({ state: "error", error: "等待 Cloudflare 分配地址超时", network: true });
			}
		}, 90_000).unref();
	}

	stop(): void {
		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null) {
			if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
			else child.kill("SIGTERM");
		}
		if (this.state.state !== "off") this.set({ state: "off" });
	}
}
