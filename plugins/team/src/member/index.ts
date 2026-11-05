import { join } from "node:path";
import type { PluginContext } from "@prometheus/plugin-sdk";
import { type HandsApi, type HandsOptions, setupHands } from "../hands/index.ts";
import { actOnSession, setupHandoff } from "../handoff/index.ts";
import { SyncManager } from "../sync/manager.ts";
import { errorMessage, LOG, TeamError } from "../types.ts";
import { checkoutWorkspace } from "./checkout.ts";
import type { MemberEnv } from "./env.ts";
import { HubClient, jwtSubject, normalizeHubUrl } from "./hub-client.ts";
import { LocalHub, type LocalHubOptions } from "./local-hub.ts";
import { SessionMirror } from "./mirror.ts";
import { TeamProvider } from "./provider.ts";
import { HubSocket, type HubSocketOptions } from "./relay.ts";
import { forkSession, resolveBinary, startSession, submitSession } from "./session-ops.ts";
import { openStateStore, type StateStore } from "./state.ts";
import { TurnUploader } from "./turn-upload.ts";

/** The slice of the plugin context the member role uses (tests pass a fake). */
export type MemberCtx = Pick<PluginContext, "dataDir" | "log" | "settings" | "sessions" | "events" | "openSession" | "rpc" | "stream" | "extension" | "onDispose" | "tools" | "cwd">;

/** What the Hub gives a tenant instance it started for its owner: where the Hub is and the long-lived credential (spec 3.1). */
export interface TenantIdentity {
	hubUrl: string;
	token: string;
}

/** Reads `TEAM_HUB_URL` and `TEAM_TENANT_TOKEN`; both must be set for this server to count as a tenant instance. */
export function tenantFromEnv(env: NodeJS.ProcessEnv = process.env): TenantIdentity | undefined {
	const hubUrl = env.TEAM_HUB_URL?.trim();
	const token = env.TEAM_TENANT_TOKEN?.trim();
	return hubUrl && token ? { hubUrl: normalizeHubUrl(hubUrl), token } : undefined;
}

export interface MemberOptions {
	/** Run as the tenant instance of this identity (default: taken from the environment, see `tenantFromEnv`). */
	tenant?: TenantIdentity | null;
	hands?: HandsOptions;
	/** Barrier timeout for side switches (default 30 s). */
	barrierMs?: number;
	fetch?: typeof fetch;
	now?: () => number;
	flushIntervalMs?: number;
	socket?: Pick<HubSocketOptions, "createSocket" | "baseDelayMs" | "maxDelayMs" | "pingMs">;
	localHub?: LocalHubOptions;
	/** Runner written into the model provider's key command (default: this process's executable). */
	execPath?: string;
}

export interface MemberApi {
	env: MemberEnv;
	state: StateStore;
	client: HubClient;
	mirror: SessionMirror;
	socket: HubSocket;
	provider: TeamProvider;
	localHub: LocalHub;
	sync: SyncManager;
	hands: HandsApi;
}

const TOPIC = /^[A-Za-z0-9_.:-]{1,60}$/;

const publicUser = (state: ReturnType<StateStore["get"]>) => (state.userId ? { id: state.userId, displayName: state.displayName, email: state.email } : undefined);

export async function setupMember(ctx: MemberCtx, options: MemberOptions = {}): Promise<MemberApi> {
	const state = await openStateStore(join(ctx.dataDir, "team"));
	const tenant = options.tenant === undefined ? tenantFromEnv() : (options.tenant ?? undefined);
	const client = new HubClient({ state, log: ctx.log, fetch: options.fetch, now: options.now, ...(tenant ? { tenant } : {}) });
	// A tenant instance keeps its clones under its own working directory unless the administrator set a root.
	const settings = (): Record<string, unknown> => (tenant && !ctx.settings.teamRoot ? { ...ctx.settings, teamRoot: join(ctx.cwd, "teams") } : ctx.settings);
	const env: MemberEnv = { client, state, log: ctx.log, settings, host: { openSession: (o) => ctx.openSession(o), sessions: ctx.sessions }, side: tenant ? "team" : "local" };
	const publish = (topic: string, data: unknown): void => {
		try {
			ctx.stream.publish(topic, data);
		} catch (err) {
			ctx.log.warn(`${LOG} 转发实时消息失败 (${topic}): ${errorMessage(err)}`);
		}
	};

	const uploader = new TurnUploader(env);
	const mirror = new SessionMirror(env, uploader, { flushIntervalMs: options.flushIntervalMs });
	const socket = new HubSocket({
		env,
		sessions: ctx.sessions,
		publish,
		kind: tenant ? "tenant" : "local",
		...(tenant ? { wsToken: () => Promise.resolve(tenant.token) } : {}),
		...options.socket,
	});
	const sync = new SyncManager(env, { socket, notify: publish, barrierMs: options.barrierMs });
	uploader.setPublisher(sync);
	const hands = setupHands(ctx, env, socket, sync, options.hands);
	const { off: offHandoff } = setupHandoff(ctx, { env, sync, mirror, uploader, notify: publish }, socket);
	const provider = new TeamProvider(env, options.execPath);
	const localHub = new LocalHub(env, options.localHub);
	ctx.extension(provider.factory);

	const offs = [
		ctx.events.onSession((id, event) => mirror.onSession(id, event)),
		ctx.events.onUiRequest((id, request) => mirror.onUiRequest(id, request)),
		ctx.events.onUiResolved((id, requestId) => mirror.onUiResolved(id, requestId)),
		client.onToken((token) => provider.onToken(token)),
	];

	const connect = async (): Promise<void> => {
		socket.start();
		// A tenant instance gets its models from the policy the Hub wrote, not through the member's own provider.
		if (tenant) return;
		await provider.refreshModels().catch((err: unknown) => ctx.log.warn(`${LOG} 刷新团队模型失败: ${errorMessage(err)}`));
	};

	const str = (params: Record<string, unknown>, key: string): string => {
		const v = params[key];
		if (typeof v !== "string" || !v) throw new TeamError("invalidParams", `缺少参数 ${key}`);
		return v;
	};

	ctx.rpc("status", () => {
		const s = state.get();
		return { connected: client.loggedIn, loggedIn: client.loggedIn, hubUrl: s.hubUrl, user: publicUser(s), realtime: socket.connected, serverId: s.serverId };
	});

	ctx.rpc("login", async (p) => {
		const user = await client.login(p.hubUrl, p.email, p.password);
		await connect();
		return { hubUrl: client.hubUrl, user };
	});

	ctx.rpc("register", async (p) => {
		const { hubUrl, result } = await client.register(p.hubUrl, p);
		if (result.status !== "active") return { status: result.status, loggedIn: false, user: result.user, bootstrap: result.bootstrap };
		const user = await client.login(hubUrl, p.email, p.password);
		await connect();
		return { status: "active", loggedIn: true, user, bootstrap: result.bootstrap, hubUrl };
	});

	ctx.rpc("logout", async () => {
		socket.stop();
		provider.clear();
		await client.logout();
		return {};
	});

	ctx.rpc("hub.request", async (p) => {
		const method = typeof p.method === "string" ? p.method.toUpperCase() : "";
		if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new TeamError("invalidParams", "method 必须是 GET/POST/PUT/PATCH/DELETE");
		const path = p.path;
		if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("..") || path.includes("#")) throw new TeamError("invalidParams", "path 必须是以 / 开头的 Hub API 路径");
		return (await client.request(method, path, p.body)).envelope;
	});

	ctx.rpc("workspace.checkout", async (p) => {
		const result = await checkoutWorkspace(env, str(p, "workspaceId"));
		return result;
	});
	ctx.rpc("sync.conflicts", async (p) => ({ conflicts: await sync.conflicts(str(p, "hubSessionId")) }));
	ctx.rpc("sync.restoreConflict", (p) => {
		const mode = p.mode;
		if (mode !== undefined && mode !== "apply" && mode !== "branch") throw new TeamError("invalidParams", "mode 必须是 apply 或 branch");
		return sync.restoreConflict(str(p, "hubSessionId"), str(p, "conflictRef"), mode);
	});
	ctx.rpc("session.act", (p) => actOnSession(env, ctx.sessions, p));
	ctx.rpc("session.start", (p) => startSession(env, p));
	ctx.rpc("session.fork", (p) => forkSession(env, p));
	ctx.rpc("session.submit", (p) => submitSession(env, p));
	ctx.rpc("session.resolveBinary", (p) => resolveBinary(env, p));

	ctx.rpc("hub.subscribe", (p) => {
		const topic = str(p, "topic");
		if (!TOPIC.test(topic)) throw new TeamError("invalidParams", "topic 无效");
		socket.subscribe(topic);
		return {};
	});
	ctx.rpc("hub.unsubscribe", (p) => {
		const topic = str(p, "topic");
		if (!TOPIC.test(topic)) throw new TeamError("invalidParams", "topic 无效");
		socket.unsubscribe(topic);
		return {};
	});

	ctx.rpc("localHub.status", () => localHub.status());
	ctx.rpc("localHub.start", (p) => localHub.start(p));
	ctx.rpc("localHub.stop", () => localHub.stop());

	ctx.onDispose(async () => {
		for (const off of offs) off();
		offHandoff();
		hands.caller.dispose();
		hands.gate.dispose();
		sync.dispose();
		await mirror.idle().catch(() => {});
		mirror.dispose();
		socket.stop();
		client.dispose();
		localHub.dispose();
	});

	if (tenant) {
		// The owner's id is known from the credential; the first access token also fills in their name.
		const userId = jwtSubject(tenant.token);
		await state.update((s) => ({ ...s, hubUrl: tenant.hubUrl, ...(userId ? { userId } : {}) }));
		void client
			.ensureToken()
			.catch((err: unknown) => ctx.log.warn(`${LOG} 换取租户访问令牌失败: ${errorMessage(err)}`))
			.finally(() => void connect());
	} else if (client.loggedIn) {
		void connect();
	}
	return { env, state, client, mirror, socket, provider, localHub, sync, hands };
}
