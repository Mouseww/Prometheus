import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import type { FolderEntry, FolderListing } from "@prometheus/protocol";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const MAX_ENTRIES = 2000;
/** Heavy or generated folders are listed but flagged, so the UI can dim them like Claude Desktop does. */
const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".cache", "target", "__pycache__", ".venv", "venv", ".idea", ".vscode"]);
const MAX_SCAN = 20000;
const INDEX_TTL = 5000;
const indexes = new Map<string, { at: number; files: FolderEntry[] }>();

/** Subsequence score: lower is better, -1 for no match. */
function score(rel: string, name: string, q: string): number {
	const r = rel.toLowerCase();
	const n = name.toLowerCase();
	if (!q) return 0;
	if (n === q) return 1;
	if (n.startsWith(q)) return 2;
	if (n.includes(q)) return 3;
	if (r.includes(q)) return 4;
	let i = 0;
	for (const c of r) if (c === q[i] && ++i === q.length) return 5;
	return -1;
}

function inside(path: string, root: string): boolean {
	const rel = relative(norm(root), norm(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export default definePlugin({
	name: "folder",
	version: "0.1.0",
	// Only adds a title-bar button and a viewer tab; nothing depends on it.
	optional: true,
	setup(ctx) {
		/** Fuzzy file search under the workspace, for @-mentions in the composer. Returns paths relative to the root. */
		ctx.rpc("search", async (p): Promise<{ items: { path: string; dir: boolean }[] }> => {
			const cwd = str(p.cwd) || ctx.cwd;
			const roots = [...(await ctx.workspaces()).map((w) => w.path), ctx.cwd, cwd];
			let root: string;
			try {
				root = await realpath(cwd);
			} catch {
				return { items: [] };
			}
			let allowed = false;
			for (const r of roots) {
				const real = await realpath(r).catch(() => undefined);
				if (real && inside(root, real)) {
					allowed = true;
					break;
				}
			}
			if (!allowed) return { items: [] };

			let idx = indexes.get(root);
			if (!idx || Date.now() - idx.at > INDEX_TTL) {
				const files: FolderEntry[] = [];
				const queue = [root];
				while (queue.length && files.length < MAX_SCAN) {
					const dirPath = queue.shift() as string;
					const dirents = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
					for (const d of dirents) {
						const full = join(dirPath, d.name);
						const isDir = d.isDirectory();
						if (!isDir && !d.isFile()) continue;
						if (isDir && (SKIP_DIRS.has(d.name) || d.name === ".")) continue;
						files.push({ name: d.name, path: relative(root, full).split(sep).join("/"), dir: isDir });
						if (isDir) queue.push(full);
					}
				}
				idx = { at: Date.now(), files };
				indexes.set(root, idx);
			}

			const q = str(p.query).toLowerCase().replace(/\\/g, "/");
			const scored: { e: FolderEntry; s: number }[] = [];
			for (const e of idx.files) {
				const s = score(e.path, e.name, q);
				if (s >= 0) scored.push({ e, s });
			}
			scored.sort((a, b) => a.s - b.s || a.e.path.split("/").length - b.e.path.split("/").length || a.e.path.localeCompare(b.e.path));
			return { items: scored.slice(0, 8).map(({ e }) => ({ path: e.path, dir: e.dir })) };
		});

		/** Paths come from clients: only folders the app already knows (workspaces, host cwd, the session's cwd) may be listed. */
		ctx.rpc("list", async (p): Promise<FolderListing> => {
			const cwd = str(p.cwd) || ctx.cwd;
			const roots = [...(await ctx.workspaces()).map((w) => w.path), ctx.cwd, cwd];
			const target = resolve(cwd, str(p.path) || ".");
			if (target.includes("\0")) throw new Error("路径无效");
			let real: string;
			try {
				real = await realpath(target);
			} catch {
				throw new Error(`文件夹不存在: ${target}`);
			}
			let allowed = false;
			for (const r of roots) {
				try {
					if (inside(real, await realpath(r))) {
						allowed = true;
						break;
					}
				} catch {
					// A workspace that no longer exists contains nothing.
				}
			}
			if (!allowed) throw new Error("只能浏览已添加工作区内的文件夹");
			if (!(await stat(real)).isDirectory()) throw new Error("不是文件夹");

			const dirents = await readdir(real, { withFileTypes: true });
			const entries: FolderEntry[] = [];
			for (const d of dirents.slice(0, MAX_ENTRIES)) {
				const path = join(real, d.name);
				let dir = d.isDirectory();
				let size: number | undefined;
				if (d.isSymbolicLink() || d.isFile()) {
					// Follow links for kind only; listing a link never grants access beyond the root (list re-checks).
					const info = await stat(path).catch(() => undefined);
					if (info) {
						dir = info.isDirectory();
						if (info.isFile()) size = info.size;
					}
				} else if (!dir) continue;
				entries.push({ name: d.name, path, dir, size });
			}
			entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
			return { path: real, entries, truncated: dirents.length > MAX_ENTRIES };
		});
	},
});
