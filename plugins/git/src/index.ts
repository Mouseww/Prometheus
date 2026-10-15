import { definePlugin } from "@prometheus/plugin-sdk";
import * as g from "./git.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export default definePlugin({
	name: "git",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		// Only folders the user has added as workspaces may be operated on, whatever a client sends.
		const dirOf = async (params: Record<string, unknown>): Promise<string> => {
			const dir = g.checkDir(params.workspace);
			const known = await ctx.workspaces();
			const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p).replace(/[\\/]+$/, "");
			if (!known.some((w) => norm(w.path) === norm(dir))) throw new g.GitError("该目录不是已添加的工作区");
			return dir;
		};

		ctx.rpc("status", async (p) => g.status(await dirOf(p)));
		ctx.rpc("log", async (p) => g.log(await dirOf(p), Number(p.limit) || 50));
		ctx.rpc("branches", async (p) => g.branches(await dirOf(p)));
		ctx.rpc("diff", async (p) => g.diff(await dirOf(p), str(p.path), p.staged === true, p.untracked === true));
		ctx.rpc("show", async (p) => g.show(await dirOf(p), str(p.hash)));

		ctx.rpc("stage", async (p) => void (await g.stage(await dirOf(p), strs(p.paths))));
		ctx.rpc("unstage", async (p) => void (await g.unstage(await dirOf(p), strs(p.paths))));
		ctx.rpc("discard", async (p) => {
			const files = Array.isArray(p.files) ? (p.files as { path?: unknown; untracked?: unknown }[]).map((f) => ({ path: str(f.path), untracked: f.untracked === true })) : [];
			await g.discard(await dirOf(p), files);
		});
		ctx.rpc("commit", async (p) => g.commit(await dirOf(p), str(p.message)));
		ctx.rpc("checkout", async (p) => void (await g.checkout(await dirOf(p), str(p.name), p.create === true)));
		ctx.rpc("fetch", async (p) => g.fetch(await dirOf(p)));
		ctx.rpc("pull", async (p) => g.pull(await dirOf(p)));
		ctx.rpc("push", async (p) => g.push(await dirOf(p)));
		ctx.rpc("init", async (p) => void (await g.init(await dirOf(p))));
	},
});
