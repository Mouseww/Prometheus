import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import { ShellSession } from "./shell.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const MAX_SESSIONS = 8;
/** A shell nobody has read from for this long is assumed abandoned (closed tab, lost connection). */
const IDLE_MS = 30 * 60_000;

export default definePlugin({
	name: "terminal",
	version: "0.1.0",
	// Nothing else depends on it: the terminal tab only exists while the user opens one.
	optional: true,
	setup(ctx) {
		const sessions = new Map<string, ShellSession>();
		const need = (id: unknown): ShellSession => {
			const s = sessions.get(str(id));
			if (!s) throw new Error("终端已关闭");
			return s;
		};
		const reap = setInterval(() => {
			for (const [id, s] of sessions) {
				if (Date.now() - s.lastUsed > IDLE_MS) {
					s.close();
					sessions.delete(id);
				}
			}
		}, 60_000);
		reap.unref();
		ctx.onDispose(() => {
			clearInterval(reap);
			for (const s of sessions.values()) s.close();
			sessions.clear();
		});

		/** Only folders the app already knows may host a shell, so a client cannot pick an arbitrary start point. */
		const allowedCwd = async (wanted: string): Promise<string> => {
			const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
			const known = [ctx.cwd, ...(await ctx.workspaces()).map((w) => w.path)].map(norm);
			const dir = resolve(wanted || ctx.cwd);
			if (!known.includes(norm(dir))) throw new Error("该目录不在已添加的项目中");
			if (!(await stat(dir).catch(() => undefined))?.isDirectory()) throw new Error("目录不存在");
			return dir;
		};

		ctx.rpc("open", async (p) => {
			if (sessions.size >= MAX_SESSIONS) throw new Error(`最多同时打开 ${MAX_SESSIONS} 个终端`);
			const cwd = await allowedCwd(str(p.cwd));
			const id = randomUUID();
			sessions.set(id, new ShellSession(id, cwd));
			return { id, cwd };
		});
		ctx.rpc("read", (p) => {
			const s = need(p.id);
			const since = typeof p.since === "number" && p.since >= 0 ? p.since : 0;
			return s.read(since);
		});
		ctx.rpc("run", (p) => {
			const line = str(p.line);
			if (line.length > 20_000) throw new Error("命令过长");
			need(p.id).run(line);
			return {};
		});
		ctx.rpc("interrupt", (p) => {
			need(p.id).interrupt();
			return {};
		});
		ctx.rpc("close", (p) => {
			const s = sessions.get(str(p.id));
			s?.close();
			sessions.delete(str(p.id));
			return {};
		});
	},
});
