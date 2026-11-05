import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { HttpMethod, PluginContext, PluginWebSocket } from "@prometheus/plugin-sdk";
import { errorMessage, LOG } from "./types.ts";

/** The part of the Hub the plugin touches. `@prometheus/hub` itself is only ever loaded through a dynamic import. */
export interface HubLike {
	handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
	registry: { require<T>(name: string): T };
	close(): Promise<void>;
}

export interface HubRealtime {
	/** Takes over a socket the host already upgraded (see `createWsGateway`). */
	attach(ws: PluginWebSocket, req: IncomingMessage): void;
}

export type HubRoleCtx = Pick<PluginContext, "dataDir" | "log" | "route" | "wsRoute" | "onDispose">;

export interface HubRoleOptions {
	env?: NodeJS.ProcessEnv;
	/** Tests replace the dynamic import. */
	createHub?: (options: Record<string, unknown>) => Promise<HubLike>;
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const HUB_BASE_PATH = "/plugins/team";

function notFound(res: ServerResponse): void {
	if (res.headersSent) return;
	const body = JSON.stringify({ ok: false, error: { code: "notFound", message: "接口不存在" } });
	res.writeHead(404, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
	res.end(body);
}

/** Hub role: the whole Hub runs inside this plugin and is mounted at `/plugins/team` (public routes: the Hub authenticates itself). */
export async function setupHubRole(ctx: HubRoleCtx, options: HubRoleOptions = {}): Promise<HubLike> {
	const env = options.env ?? process.env;
	const create = options.createHub ?? (async (o: Record<string, unknown>) => (await import("@prometheus/hub")).createHub(o as never) as unknown as HubLike);
	const hubDir = join(ctx.dataDir, "hub");
	const hub = await create({
		dataDir: hubDir,
		databaseUrl: env.HUB_DATABASE_URL || undefined,
		publicUrl: env.HUB_PUBLIC_URL || undefined,
		basePath: HUB_BASE_PATH,
		log: ctx.log,
		// The Hub reads HUB_TRUST_PROXY (and the other HUB_* settings) from this env; a bad value fails startup.
		env,
	});

	const handler = (req: IncomingMessage, res: ServerResponse): void => {
		hub.handle(req, res).then(
			(handled) => {
				if (!handled) notFound(res);
			},
			(err: unknown) => {
				ctx.log.error(`${LOG} Hub 处理请求时出错: ${errorMessage(err)}`);
				if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: false, error: { code: "internalError", message: "服务器内部错误" } }));
			},
		);
	};
	for (const method of METHODS) ctx.route(method, "/*", handler, { auth: "public" });

	ctx.wsRoute(
		"/ws",
		(ws, req) => {
			hub.registry.require<HubRealtime>("realtime").attach(ws, req);
		},
		{ auth: "public" },
	);

	ctx.onDispose(() => hub.close());

	const setupCode = join(hubDir, "setup-code.txt");
	if (existsSync(setupCode)) ctx.log.warn(`${LOG} Hub 尚无任何账号：首个账号的设置码保存在 ${setupCode}（0600），请在注册页填写。`);
	ctx.log.info(`${LOG} 团队 Hub 已启动，接口位于 ${HUB_BASE_PATH}/api，数据目录 ${hubDir}`);
	return hub;
}
