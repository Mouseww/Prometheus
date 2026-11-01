// Downloads Chrome for Testing into the plugin's data folder for machines without a Chromium-family browser
// (servers, containers, a bare Linux desktop). Plain Node: fetch for the download, zlib for the zip.
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);

const VERSIONS_URL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
/** Used when the version list cannot be reached (it is hosted on GitHub Pages, which some networks block). */
const FALLBACK_VERSION = "131.0.6778.204";
const MIRRORS = [
	(v: string, p: string) => `https://storage.googleapis.com/chrome-for-testing-public/${v}/${p}/chrome-${p}.zip`,
	(v: string, p: string) => `https://cdn.npmmirror.com/binaries/chrome-for-testing/${v}/${p}/chrome-${p}.zip`,
];

export type CftPlatform = "win64" | "win32" | "mac-x64" | "mac-arm64" | "linux64";

export function cftPlatform(): CftPlatform | undefined {
	if (process.platform === "win32") return process.arch === "x64" || process.arch === "arm64" ? "win64" : "win32";
	if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
	if (process.platform === "linux" && process.arch === "x64") return "linux64";
	return undefined;
}

export function cftExecutable(root: string, platform: CftPlatform): string {
	const top = join(root, `chrome-${platform}`);
	if (platform.startsWith("win")) return join(top, "chrome.exe");
	if (platform.startsWith("mac")) return join(top, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
	return join(top, "chrome");
}

export interface InstallProgress {
	stage: "resolve" | "download" | "extract" | "done" | "error";
	done: number;
	total: number;
	message?: string;
}

async function latestVersion(signal?: AbortSignal): Promise<string> {
	try {
		const res = await fetch(VERSIONS_URL, { signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
		if (!res.ok) throw new Error(String(res.status));
		const json = (await res.json()) as { channels?: { Stable?: { version?: string } } };
		return json.channels?.Stable?.version ?? FALLBACK_VERSION;
	} catch {
		if (signal?.aborted) throw new Error("已取消");
		return FALLBACK_VERSION;
	}
}

async function download(url: string, file: string, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
	const res = await fetch(url, { signal });
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
	const total = Number(res.headers.get("content-length") ?? 0);
	let done = 0;
	let last = 0;
	const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
	body.on("data", (chunk: Buffer) => {
		done += chunk.length;
		const now = Date.now();
		if (now - last > 250) {
			last = now;
			onProgress(done, total);
		}
	});
	await pipeline(body, createWriteStream(file));
	onProgress(done, total || done);
}

interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	size: number;
	localOffset: number;
	mode: number;
}

async function readEntries(file: string): Promise<{ entries: ZipEntry[]; handle: import("node:fs/promises").FileHandle }> {
	const handle = await open(file, "r");
	const { size } = await handle.stat();
	const tailLen = Math.min(size, 65_557);
	const tail = Buffer.alloc(tailLen);
	await handle.read(tail, 0, tailLen, size - tailLen);
	let eocd = -1;
	for (let i = tailLen - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("不是有效的 zip 文件");
	const count = tail.readUInt16LE(eocd + 10);
	const cdSize = tail.readUInt32LE(eocd + 12);
	const cdOffset = tail.readUInt32LE(eocd + 16);
	if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("不支持 zip64");
	const cd = Buffer.alloc(cdSize);
	await handle.read(cd, 0, cdSize, cdOffset);
	const entries: ZipEntry[] = [];
	let p = 0;
	for (let i = 0; i < count; i++) {
		if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 目录损坏");
		const madeBy = cd.readUInt16LE(p + 4);
		const method = cd.readUInt16LE(p + 10);
		const compressedSize = cd.readUInt32LE(p + 20);
		const usize = cd.readUInt32LE(p + 24);
		const nameLen = cd.readUInt16LE(p + 28);
		const extraLen = cd.readUInt16LE(p + 30);
		const commentLen = cd.readUInt16LE(p + 32);
		const external = cd.readUInt32LE(p + 38);
		const localOffset = cd.readUInt32LE(p + 42);
		const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
		entries.push({ name, method, compressedSize, size: usize, localOffset, mode: madeBy >> 8 === 3 ? external >>> 16 : 0 });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return { entries, handle };
}

/** Extracts a zip, keeping executable bits and the symlinks macOS app bundles rely on. */
export async function extractZip(file: string, outDir: string, onProgress?: (done: number, total: number) => void): Promise<void> {
	const { entries, handle } = await readEntries(file);
	try {
		const root = normalize(outDir) + sep;
		const total = entries.reduce((s, e) => s + e.compressedSize, 0);
		let done = 0;
		for (const e of entries) {
			const target = normalize(join(outDir, e.name));
			if (!target.startsWith(root)) throw new Error(`zip 中有越界路径：${e.name}`);
			if (e.name.endsWith("/")) {
				await mkdir(target, { recursive: true });
				continue;
			}
			const head = Buffer.alloc(30);
			await handle.read(head, 0, 30, e.localOffset);
			if (head.readUInt32LE(0) !== 0x04034b50) throw new Error("zip 条目损坏");
			const dataStart = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
			const raw = Buffer.alloc(e.compressedSize);
			await handle.read(raw, 0, e.compressedSize, dataStart);
			const data = e.method === 0 ? raw : e.method === 8 ? await inflate(raw) : undefined;
			if (!data) throw new Error(`不支持的压缩方式 ${e.method}`);
			await mkdir(dirname(target), { recursive: true });
			const type = e.mode & 0o170000;
			if (type === 0o120000) {
				await rm(target, { force: true });
				await symlink(data.toString("utf8"), target);
			} else {
				await writeFile(target, data);
				if (e.mode & 0o111) await chmod(target, e.mode & 0o777);
			}
			done += e.compressedSize;
			onProgress?.(done, total);
		}
	} finally {
		await handle.close();
	}
}

/** Downloads and unpacks Chrome for Testing under `root`; returns the executable. */
export async function installChrome(root: string, onProgress: (p: InstallProgress) => void, signal?: AbortSignal): Promise<string> {
	const platform = cftPlatform();
	if (!platform) throw new Error("这个平台没有可下载的 Chrome，请用系统包管理器安装 chromium");
	onProgress({ stage: "resolve", done: 0, total: 0 });
	const version = await latestVersion(signal);
	await mkdir(root, { recursive: true });
	const zip = join(root, `chrome-${platform}.zip.part`);
	let lastError: unknown;
	let ok = false;
	for (const mirror of MIRRORS) {
		try {
			await download(mirror(version, platform), zip, (done, total) => onProgress({ stage: "download", done, total, message: version }), signal);
			ok = true;
			break;
		} catch (err) {
			lastError = err;
			if (signal?.aborted) break;
		}
	}
	if (!ok) {
		await rm(zip, { force: true });
		throw new Error(`下载 Chrome 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
	}
	const staging = join(root, "staging");
	await rm(staging, { recursive: true, force: true });
	await extractZip(zip, staging, (done, total) => onProgress({ stage: "extract", done, total }));
	const finalDir = join(root, `chrome-${platform}`);
	await rm(finalDir, { recursive: true, force: true });
	await rename(join(staging, `chrome-${platform}`), finalDir);
	await rm(staging, { recursive: true, force: true });
	await rm(zip, { force: true });
	await writeFile(join(root, "version.txt"), version);
	const exe = cftExecutable(root, platform);
	if (!existsSync(exe)) throw new Error("解压后找不到浏览器可执行文件");
	onProgress({ stage: "done", done: 1, total: 1, message: version });
	return exe;
}
