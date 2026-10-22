import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import { formatResult, scpTransfer, type SshHost, sshExec, validateHost } from "./ssh.ts";

interface State {
	hosts: SshHost[];
}

const MASK = "••••••";
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
/** Clients never see the stored credential, only a mask telling them one exists. */
const view = (h: SshHost) => ({ ...h, secret: h.secret ? MASK : "" });

export default definePlugin({
	name: "ssh",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		const store = createJsonStore<State>(join(ctx.dataDir, "hosts.json"), () => ({ hosts: [] }));

		const find = async (ref: unknown): Promise<SshHost> => {
			const key = str(ref).toLowerCase();
			const { hosts } = await store.read();
			const hit = hosts.find((h) => h.id === key || h.name.toLowerCase() === key);
			if (!hit) throw new Error(`没有名为 ${str(ref)} 的 SSH 主机，请先在 设置 → SSH 中添加`);
			return hit;
		};

		ctx.rpc("list", async () => ({ hosts: (await store.read()).hosts.map(view) }));

		ctx.rpc("save", async (p) => {
			const h = (p.host ?? {}) as Partial<SshHost>;
			const auth = h.auth === "password" || h.auth === "agent" ? h.auth : "key";
			const next: SshHost = {
				id: str(h.id) || randomUUID().slice(0, 8),
				name: str(h.name),
				host: str(h.host),
				port: Number(h.port) || 22,
				user: str(h.user),
				auth,
				identityFile: str(h.identityFile) || undefined,
				secret: typeof h.secret === "string" ? h.secret : undefined,
				note: str(h.note) || undefined,
			};
			if (!next.name) next.name = `${next.user}@${next.host}`;
			validateHost(next);
			await store.update((s) => {
				const old = s.hosts.find((x) => x.id === next.id);
				if (next.auth !== "password") next.secret = undefined;
				else if (!next.secret || next.secret === MASK) next.secret = old?.secret;
				if (s.hosts.some((x) => x.id !== next.id && x.name.toLowerCase() === next.name.toLowerCase())) throw new Error("名称已被使用");
				return { hosts: old ? s.hosts.map((x) => (x.id === next.id ? next : x)) : [...s.hosts, next] };
			});
			ctx.notifyChanged();
			return view(next);
		});

		ctx.rpc("delete", async (p) => {
			const id = str(p.id);
			await store.update((s) => ({ hosts: s.hosts.filter((h) => h.id !== id) }));
			ctx.notifyChanged();
			return {};
		});

		ctx.rpc("test", async (p) => {
			const h = await find(p.id);
			const started = Date.now();
			try {
				const r = await sshExec(h, "echo prometheus-ok", 20_000);
				const ok = r.code === 0 && r.stdout.includes("prometheus-ok");
				return { ok, latencyMs: Date.now() - started, message: ok ? "连接成功" : (r.stderr || r.stdout || "连接失败").trim().slice(0, 400) };
			} catch (err) {
				return { ok: false, latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) };
			}
		});

		ctx.extension((pi) => {
			pi.registerTool({
				name: "ssh_hosts",
				label: "SSH 主机列表",
				description: "List the SSH servers the user has configured (name, host, user). Use the name with ssh_exec.",
				promptSnippet: "ssh_hosts: list configured SSH servers",
				parameters: Type.Object({}),
				async execute() {
					const { hosts } = await store.read();
					if (!hosts.length) return text("尚未配置任何 SSH 主机。");
					return text(hosts.map((h) => `${h.name}\t${h.user}@${h.host}:${h.port}${h.note ? `\t${h.note}` : ""}`).join("\n"));
				},
			});
			pi.registerTool({
				name: "ssh_exec",
				label: "SSH 执行命令",
				description: "Run a shell command on a configured SSH server and return stdout, stderr and the exit code. Non-interactive only (no TTY, no stdin).",
				promptSnippet: "ssh_exec: run a command on a configured remote server over SSH",
				parameters: Type.Object({
					host: Type.String({ description: "Configured host name or id (see ssh_hosts)" }),
					command: Type.String({ description: "Shell command to run remotely", maxLength: 20000 }),
					timeoutSeconds: Type.Optional(Type.Number({ description: "Default 60, max 600" })),
				}),
				async execute(_id, p) {
					const h = await find(p.host);
					const secs = Math.min(600, Math.max(1, Number(p.timeoutSeconds) || 60));
					return text(formatResult(await sshExec(h, p.command, secs * 1000)));
				},
			});
			pi.registerTool({
				name: "ssh_upload",
				label: "SSH 上传",
				description: "Copy a local file or folder to a configured SSH server with scp.",
				promptSnippet: "ssh_upload: copy a local path to a remote server",
				parameters: Type.Object({ host: Type.String(), localPath: Type.String(), remotePath: Type.String() }),
				async execute(_id, p) {
					return text(formatResult(await scpTransfer(await find(p.host), "up", p.localPath, p.remotePath)));
				},
			});
			pi.registerTool({
				name: "ssh_download",
				label: "SSH 下载",
				description: "Copy a file or folder from a configured SSH server to the local machine with scp.",
				promptSnippet: "ssh_download: copy a remote path to the local machine",
				parameters: Type.Object({ host: Type.String(), remotePath: Type.String(), localPath: Type.String() }),
				async execute(_id, p) {
					return text(formatResult(await scpTransfer(await find(p.host), "down", p.localPath, p.remotePath)));
				},
			});
		});
	},
});
