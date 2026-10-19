import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import type { WorkbenchFile } from "@prometheus/protocol";

export const MAX_TEXT = 1024 * 1024;
export const MAX_IMAGE = 8 * 1024 * 1024;

const IMAGES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

const LANGUAGES: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
	".json": "json", ".md": "markdown", ".markdown": "markdown", ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
	".c": "c", ".h": "c", ".cpp": "cpp", ".cs": "csharp", ".css": "css", ".html": "html", ".htm": "html", ".xml": "xml",
	".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".sh": "shell", ".ps1": "powershell", ".sql": "sql", ".txt": "text",
};

export const languageOf = (path: string): string => LANGUAGES[extname(path).toLowerCase()] ?? "text";

/** NUL bytes in the first 8 KB: the same cheap test git uses to call a file binary. */
export function looksBinary(buf: Uint8Array): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** True when `path` is `root` or inside it. Both must already be real paths. */
export function isInside(path: string, root: string): boolean {
	const rel = relative(norm(root), norm(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a client- or model-supplied path and make sure it lands inside one of the allowed roots.
 * Symlinks are resolved first so a link inside a workspace cannot point out of it.
 */
export async function resolveAllowed(path: string, cwd: string, roots: string[]): Promise<string> {
	if (!path.trim() || path.includes("\0")) throw new Error("路径无效");
	const full = resolve(cwd, path.replace(/^@/, ""));
	let real: string;
	try {
		real = await realpath(full);
	} catch {
		throw new Error(`文件不存在: ${path}`);
	}
	for (const root of roots) {
		try {
			if (isInside(real, await realpath(root))) return real;
		} catch {
			// A workspace that no longer exists cannot contain anything.
		}
	}
	throw new Error("只能查看已添加工作区内的文件");
}

export async function readForViewer(real: string): Promise<WorkbenchFile> {
	const info = await stat(real);
	if (!info.isFile()) throw new Error("不是文件");
	const base = { path: real, name: basename(real), size: info.size, language: languageOf(real) };
	const mime = IMAGES[extname(real).toLowerCase()];
	if (mime) {
		if (info.size > MAX_IMAGE) return { ...base, kind: "tooLarge" };
		const data = await readFile(real);
		return { ...base, kind: "image", dataUrl: `data:${mime};base64,${data.toString("base64")}` };
	}
	const data = await readFile(real);
	if (looksBinary(data)) return { ...base, kind: "binary" };
	if (data.length > MAX_TEXT) return { ...base, kind: "text", text: data.subarray(0, MAX_TEXT).toString("utf8"), truncated: true };
	return { ...base, kind: "text", text: data.toString("utf8") };
}
