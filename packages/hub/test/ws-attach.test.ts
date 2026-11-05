import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Collab, startCollab } from "./s-helpers.ts";

/** What a plugin host does: it owns the HTTP server and the upgrade, then hands the open socket to the Hub. */
let c: Collab;
let host: Server;
let wss: WebSocketServer;
let port = 0;

beforeAll(async () => {
	c = await startCollab();
	wss = new WebSocketServer({ noServer: true });
	host = createServer();
	host.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => (c.realtime as unknown as { attach(ws: WebSocket, req: unknown): void }).attach(ws, req));
	});
	await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
	port = (host.address() as AddressInfo).port;
});
afterAll(async () => {
	host.closeAllConnections();
	await new Promise<void>((resolve) => host.close(() => resolve()));
	wss.close();
	await c.stop();
});

const open = (token: string | undefined): Promise<{ ws: WebSocket; frames: any[] }> =>
	new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/plugins/team/ws${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`);
		const frames: any[] = [];
		ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
		ws.once("open", () => resolve({ ws, frames }));
		ws.once("error", reject);
	});

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("等待超时");
		await new Promise((r) => setTimeout(r, 10));
	}
};

describe("attach(ws, req)", () => {
	it("accepts an upgraded socket with a valid token and processes messages sent right after open", async () => {
		const { ws, frames } = await open(c.alice.token);
		// Sent before the Hub has finished checking the token: it must not be lost.
		ws.send(JSON.stringify({ type: "subscribe", topic: "user" }));
		await until(() => frames.some((f) => f.type === "subscribed" && f.topic === "user"));
		expect(frames.some((f) => f.type === "ready" && f.userId === c.alice.userId)).toBe(true);
		expect(c.realtime.isOnline(c.alice.userId)).toBe(true);

		ws.send(JSON.stringify({ type: "ping" }));
		await until(() => frames.some((f) => f.type === "pong"));
		ws.close();
		await until(() => !c.realtime.isOnline(c.alice.userId));
	});

	it("closes sockets with a missing or bad token using code 4401", async () => {
		for (const token of [undefined, "garbage"]) {
			const { ws } = await open(token);
			const code = await new Promise<number>((resolve) => ws.once("close", (cd) => resolve(cd)));
			expect(code).toBe(4401);
		}
	});

	it("delivers relays to an attached socket and takes the relayResult back", async () => {
		const { ws, frames } = await open(c.alice.token);
		await until(() => frames.some((f) => f.type === "ready"));
		const sent = c.realtime.relay(c.alice.userId, { hubSessionId: "h", sessionId: "l", serverId: "s", action: { type: "abort" }, actor: { userId: c.bob.userId, name: "Bob" } }, 3000);
		await until(() => frames.some((f) => f.type === "relay"));
		const relay = frames.find((f) => f.type === "relay");
		expect(relay).toMatchObject({ hubSessionId: "h", sessionId: "l", action: { type: "abort" }, actor: { name: "Bob" } });
		ws.send(JSON.stringify({ type: "relayResult", relayId: relay.relayId, ok: true }));
		expect(await sent).toEqual({ kind: "ok" });
		ws.close();
	});
});
