import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import type { FolderEntry, FolderListing } from "@prometheus/protocol";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const MAX_ENTRIES = 2000;
/** Heavy or generated folders are listed but flagged, so the UI can dim them like Claude Desktop does. */
const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

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
