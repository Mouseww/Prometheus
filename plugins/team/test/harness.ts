import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory, OpenSessionOptions, PluginContext, PluginTool, RpcHandler } from "@prometheus/plugin-sdk";
import type { SessionEvent, UIRequest, UIResponse } from "@prometheus/protocol";
import { PASSWORD } from "../../../packages/hub/test/hub-helpers.ts";
import { setupWorld, type World } from "../../../packages/hub/test/git-helpers.ts";
import { type MemberApi, type MemberCtx, type MemberOptions, setupMember } from "../src/member/index.ts";

export { PASSWORD };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(probe: () => T | Promise<T>, what = "条件", ms = 8000): Promise<NonNullable<T>> {
	const end = Date.now() + ms;
	for (;;) {
		const value = await probe();
		if (value) return value as NonNullable<T>;
		if (Date.now() > end) throw new Error(`等待超时: ${what}`);
		await sleep(15);
	}
}

export interface SessionCall {
	kind: "prompt" | "respond" | "abort";
	sessionId: string;
	text?: string;
	actor?: string;
	requestId?: string;
	response?: UIResponse;
}

export interface FakeCtx extends MemberCtx {
	dir: string;
	/** Tools registered through `ctx.tools.register`, by name. */
	tools: MemberCtx["tools"] & { registered: Map<string, PluginTool> };
	logs: string[];
	rpcs: Map<string, RpcHandler>;
	call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
	emit: {
		session(sessionId: string, event: SessionEvent): void;
		uiRequest(sessionId: string, request: UIRequest): void;
		uiResolved(sessionId: string, requestId: string): void;
	};
	opened: (OpenSessionOptions & { sessionId: string })[];
	imported: { cwd: string; content: string; name?: string; sessionId: string }[];
	calls: SessionCall[];
	published: { topic: string; data: unknown }[];
	factories: ExtensionFactory[];
	transcripts: Map<string, string>;
	disposers: (() => void | Promise<void>)[];
	dispose(): Promise<void>;
}

/** A minimal in-memory stand-in for the part of `PluginContext` the member role uses. */
export function fakeCtx(dir: string, settings: Record<string, unknown> = {}): FakeCtx {
	const logs: string[] = [];
	const rpcs = new Map<string, RpcHandler>();
	const sessionListeners = new Set<(id: string, e: SessionEvent, info: { owner?: string; cwd: string }) => void>();
	const requestListeners = new Set<(id: string, r: UIRequest) => void>();
	const resolvedListeners = new Set<(id: string, rid: string) => void>();
	const opened: FakeCtx["opened"] = [];
	const imported: FakeCtx["imported"] = [];
	const calls: SessionCall[] = [];
	const published: FakeCtx["published"] = [];
	const factories: ExtensionFactory[] = [];
	const transcripts = new Map<string, string>();
	const disposers: FakeCtx["disposers"] = [];
	const registeredTools = new Map<string, PluginTool>();
	let counter = 0;

	const ctx: FakeCtx = {
		dir,
		logs,
		rpcs,
		dataDir: join(dir, "data"),
		cwd: dir,
		tools: { register: (tool) => void registeredTools.set(tool.name, tool), registered: registeredTools },
		settings,
		log: { info: (m) => void logs.push(m), warn: (m) => void logs.push(m), error: (m) => void logs.push(m) },
		sessions: {
			info: async () => undefined,
			prompt: async (sessionId, text, opts) => void calls.push({ kind: "prompt", sessionId, text, actor: opts?.actor }),
			respond: async (sessionId, requestId, response) => void calls.push({ kind: "respond", sessionId, requestId, response }),
			abort: async (sessionId) => void calls.push({ kind: "abort", sessionId }),
			exportTranscript: async (sessionId) => (transcripts.has(sessionId) ? { format: "pi-jsonl" as const, content: transcripts.get(sessionId) as string } : undefined),
			importTranscript: async (opts) => {
				const sessionId = `imported-${++counter}`;
				imported.push({ cwd: opts.cwd, content: opts.content, name: opts.name, sessionId });
				return { sessionId };
			},
			setBadge: async () => {},
		},
		events: {
			onSession: (l) => (sessionListeners.add(l), () => void sessionListeners.delete(l)),
			onSessionsChanged: () => () => {},
			onUiRequest: (l) => (requestListeners.add(l), () => void requestListeners.delete(l)),
			onUiResolved: (l) => (resolvedListeners.add(l), () => void resolvedListeners.delete(l)),
		},
		openSession: async (options) => {
			const sessionId = `local-${++counter}`;
			opened.push({ ...options, sessionId });
			return { sessionId };
		},
		rpc: (method, handler) => void rpcs.set(method, handler),
		stream: { publish: (topic, data) => void published.push({ topic, data }), watchers: () => 0, onWatch: () => {} },
		extension: (factory) => void factories.push(factory),
		onDispose: (fn) => void disposers.push(fn),
		call: async (method, params = {}) => {
			const handler = rpcs.get(method);
			if (!handler) throw new Error(`没有 RPC 方法 ${method}`);
			return (await handler(params)) as never;
		},
		emit: {
			session: (id, event) => sessionListeners.forEach((l) => l(id, event, { cwd: dir })),
			uiRequest: (id, request) => requestListeners.forEach((l) => l(id, request)),
			uiResolved: (id, rid) => resolvedListeners.forEach((l) => l(id, rid)),
		},
		opened,
		imported,
		calls,
		published,
		factories,
		transcripts,
		disposers,
		async dispose() {
			for (const fn of [...disposers].reverse()) await fn();
			disposers.length = 0;
		},
	};
	return ctx;
}

let ipCounter = 1;
/** Every request gets its own client address so the Hub's login rate limit does not trip across tests. */
export const freshIpFetch: typeof fetch = (input, init) => {
	const headers = new Headers(init?.headers);
	headers.set("x-forwarded-for", `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`);
	return fetch(input, { ...init, headers });
};

export interface TeamWorld {
	world: World;
	/** Hub address without the `/plugins/team` mount prefix: what a member types into the login form. */
	hubUrl: string;
	stop(): Promise<void>;
}

/** A Hub mounted at `/plugins/team` (like the plugin does) with a team, a workspace and members alice, bob (reviewer), dan (admin). */
export async function startTeamWorld(): Promise<TeamWorld> {
	const world = await setupWorld({ hub: { basePath: "/plugins/team" } });
	world.t.server.on("upgrade", (req, socket, head) => {
		if (!world.t.hub.handleUpgrade(req, socket, head)) socket.destroy();
	});
	return {
		world,
		hubUrl: world.t.baseUrl.replace(/\/plugins\/team$/, ""),
		async stop() {
			world.t.server.closeAllConnections();
			await world.stop();
		},
	};
}

export interface Member {
	ctx: FakeCtx;
	api: MemberApi;
	root: string;
	teamRoot: string;
	fetchLog: { method: string; url: string }[];
	stop(): Promise<void>;
}

export interface StartMemberOptions extends MemberOptions {
	/** Skip the login (for tests of the login itself). */
	login?: boolean;
	root?: string;
}

export async function startMember(tw: TeamWorld, email: string, options: StartMemberOptions = {}): Promise<Member> {
	const root = options.root ?? (await mkdtemp(join(tmpdir(), "team-member-")));
	const teamRoot = join(root, "teams");
	const ctx = fakeCtx(root, { teamRoot });
	const fetchLog: Member["fetchLog"] = [];
	const base = options.fetch ?? freshIpFetch;
	const api = await setupMember(ctx, {
		flushIntervalMs: 20,
		socket: { baseDelayMs: 50, maxDelayMs: 200 },
		...options,
		fetch: (input, init) => {
			fetchLog.push({ method: init?.method ?? "GET", url: String(input) });
			return base(input, init);
		},
	});
	if (options.login !== false) await ctx.call("login", { hubUrl: tw.hubUrl, email, password: PASSWORD });
	return {
		ctx,
		api,
		root,
		teamRoot,
		fetchLog,
		async stop() {
			await ctx.dispose();
		},
	};
}

export const readText = (path: string): Promise<string> => readFile(path, "utf8");

export type TestFrame = Record<string, unknown>;

/** Two Hub-socket stand-ins wired back to back: a frame one sends reaches the other's `onFrame` handlers (the Hub in between is out of scope). */
export function socketPair() {
	const handlers: [Set<(f: TestFrame) => unknown>, Set<(f: TestFrame) => unknown>] = [new Set(), new Set()];
	const sent: [TestFrame[], TestFrame[]] = [[], []];
	const make = (me: 0 | 1) => ({
		sendFrame: (frame: TestFrame): boolean => {
			const copy = JSON.parse(JSON.stringify(frame)) as TestFrame;
			sent[me].push(copy);
			queueMicrotask(() => handlers[me === 0 ? 1 : 0].forEach((h) => void h(copy)));
			return true;
		},
		onFrame: (h: (f: TestFrame) => unknown) => (handlers[me].add(h), () => void handlers[me].delete(h)),
	});
	return { a: make(0), b: make(1), sent };
}
