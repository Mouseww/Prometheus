import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { ulid } from "../src/ids.ts";
import type { Realtime } from "../src/services/realtime.ts";
import type { SessionsService } from "../src/services/sessions.ts";
import { startHub, type TestHub } from "./hub-helpers.ts";

export interface Person {
	token: string;
	userId: string;
}

export interface Collab {
	t: TestHub;
	clock: { offset: number };
	root: Person & { orgId: string };
	alice: Person;
	bob: Person;
	carol: Person;
	teamId: string;
	workspaceId: string;
	sessions: SessionsService;
	realtime: Realtime & { sweep(): Promise<number>; connectionCount(userId?: string): number };
	/** Registers a session as Alice on the workspace. */
	registerSession(who?: Person, extra?: Record<string, unknown>): Promise<any>;
	stop(): Promise<void>;
}

/**
 * A Hub with an org owner (root, operator), a team with Alice and Bob (members) and a workspace row,
 * plus Carol who belongs to the org but not to the team. The workspace row is inserted directly so these tests do not need git.
 */
export async function startCollab(options: { teamName?: string } = {}): Promise<Collab> {
	const clock = { offset: 0 };
	const t = await startHub({ now: () => Date.now() + clock.offset });
	// startHub's server has no upgrade listener; the Hub installs its WebSocket handler through deps.setUpgradeHandler.
	t.server.on("upgrade", (req, socket, head) => {
		if (!t.hub.handleUpgrade(req, socket, head)) socket.destroy();
	});
	const root = await t.bootstrap();
	const alice = await t.createUser(root.token, "alice@corp.test", "Alice");
	const bob = await t.createUser(root.token, "bob@corp.test", "Bob");
	const carol = await t.createUser(root.token, "carol@corp.test", "Carol");

	const team = await t.api("POST", "/api/teams", { token: root.token, body: { name: options.teamName ?? "Core", orgId: root.orgId } });
	if (team.status !== 201) throw new Error(`建团队失败: ${JSON.stringify(team.body)}`);
	const teamId = team.data.id as string;
	for (const p of [alice, bob]) {
		const r = await t.api("POST", `/api/teams/${teamId}/members`, { token: root.token, body: { userId: p.userId, role: "member" } });
		if (r.status !== 201) throw new Error(`加成员失败: ${JSON.stringify(r.body)}`);
	}
	const workspaceId = ulid();
	await t.hub.db.tx({ system: true }, (q) =>
		q.query("INSERT INTO workspaces (id, team_id, org_id, name, repo_dir) VALUES ($1,$2,$3,$4,$5)", [workspaceId, teamId, root.orgId, "main-ws", `repos/${workspaceId}.git`]),
	);

	let counter = 0;
	return {
		t,
		clock,
		root,
		alice,
		bob,
		carol,
		teamId,
		workspaceId,
		sessions: t.hub.registry.require<SessionsService>("sessions"),
		realtime: t.hub.registry.require("realtime"),
		async registerSession(who = alice, extra = {}) {
			counter++;
			const r = await t.api("POST", `/api/workspaces/${workspaceId}/sessions`, {
				token: who.token,
				body: { localSessionId: `local-${counter}`, serverId: "srv-1", title: `Session ${counter}`, branch: `session/${who.userId}/x${counter}`, baseCommit: "a".repeat(40), ...extra },
			});
			if (r.status !== 201 && r.status !== 200) throw new Error(`登记会话失败: ${JSON.stringify(r.body)}`);
			return r.data;
		},
		stop() {
			// Open WebSocket or keep-alive connections would make server.close wait for them.
			t.server.closeAllConnections();
			return t.stop();
		},
	};
}

export interface WsClient {
	ws: WebSocket;
	frames: any[];
	send(frame: unknown): void;
	/** Resolves with the first not yet consumed frame matching `pred`. */
	waitFor(pred: (f: any) => boolean, timeoutMs?: number): Promise<any>;
	/** Subscribes and waits for the server's answer (subscribed or error). */
	subscribe(topic: string): Promise<any>;
	/** Answers every relay frame with `reply(frame)`. */
	autoRelay(reply: (frame: any) => { ok: boolean; error?: string } | undefined): void;
	close(): Promise<void>;
}

export function wsUrl(baseUrl: string, token: string | undefined): string {
	return `${baseUrl.replace(/^http/, "ws")}/ws${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;
}

export function connectWs(baseUrl: string, token: string | undefined): Promise<WsClient> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl(baseUrl, token));
		const frames: any[] = [];
		let cursor = 0;
		const listeners = new Set<() => void>();
		ws.on("message", (raw) => {
			frames.push(JSON.parse(raw.toString()));
			for (const l of [...listeners]) l();
		});
		const client: WsClient = {
			ws,
			frames,
			send: (f) => ws.send(JSON.stringify(f)),
			waitFor(pred, timeoutMs = 3000) {
				return new Promise((res, rej) => {
					const check = (): boolean => {
						for (let i = cursor; i < frames.length; i++) {
							if (pred(frames[i])) {
								cursor = i + 1;
								listeners.delete(check2);
								clearTimeout(timer);
								res(frames[i]);
								return true;
							}
						}
						return false;
					};
					const check2 = (): void => void check();
					const timer = setTimeout(() => {
						listeners.delete(check2);
						rej(new Error(`等待 WebSocket 消息超时，已收到: ${JSON.stringify(frames.slice(cursor))}`));
					}, timeoutMs);
					if (!check()) listeners.add(check2);
				});
			},
			async subscribe(topic) {
				client.send({ type: "subscribe", topic });
				return client.waitFor((f) => (f.type === "subscribed" || f.type === "error") && f.topic === topic);
			},
			autoRelay(reply) {
				ws.on("message", (raw) => {
					const f = JSON.parse(raw.toString());
					if (f.type !== "relay") return;
					const result = reply(f);
					if (result) client.send({ type: "relayResult", relayId: f.relayId, ...result });
				});
			},
			close: () =>
				new Promise<void>((res) => {
					if (ws.readyState === WebSocket.CLOSED) return res();
					ws.once("close", () => res());
					ws.close();
				}),
		};
		ws.once("open", () => {
			// The server greets with `ready`; consume it so tests start with a clean slate.
			void client.waitFor((f) => f.type === "ready").then(() => resolve(client), reject);
		});
		ws.once("error", reject);
		ws.once("unexpected-response", (_req, res) => reject(new Error(`升级被拒绝: ${res.statusCode}`)));
	});
}

export interface Upstream {
	server: Server;
	url: string;
	requests: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[];
	stop(): Promise<void>;
}

/** A local HTTP server standing in for an LLM provider. `handler` writes the reply. */
export async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>): Promise<Upstream> {
	const requests: Upstream["requests"] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			void handler(req, res, body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		server,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		stop: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export const sse = (events: { event?: string; data: unknown }[]): string =>
	events.map((e) => `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`).join("");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
