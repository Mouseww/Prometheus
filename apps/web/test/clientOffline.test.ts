import { afterEach, describe, expect, it, vi } from "vitest";

const noop = () => undefined;
vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }), addEventListener: noop, removeEventListener: noop, innerWidth: 1200 });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: noop, removeItem: noop });
vi.stubGlobal("document", {
	documentElement: { classList: { add: noop, remove: noop, toggle: noop }, style: { setProperty: noop }, dataset: {} },
	querySelector: () => ({ setAttribute: noop }),
	createElement: () => ({ setAttribute: noop }),
	head: { append: noop },
	addEventListener: noop,
	removeEventListener: noop,
	visibilityState: "visible",
});
// i18n reads browser globals while loading, so the client is imported after they exist.
const { OfflineError, PrometheusClient } = await import("../src/lib/client.ts");

class FakeSocket {
	static last: FakeSocket | undefined;
	static readonly OPEN = 1;
	readyState = 0;
	binaryType = "";
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	onclose: ((ev: { code: number }) => void) | null = null;
	sent: string[] = [];
	constructor(readonly url: string) {
		FakeSocket.last = this;
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
	hello() {
		this.readyState = 1;
		this.onmessage?.({ data: JSON.stringify({ type: "hello", authRequired: false }) });
	}
}

const make = () => new PrometheusClient({ wsUrl: "ws://x", httpBase: "http://x", label: "t" });

afterEach(() => {
	vi.useRealTimers();
});

describe("requests while the link is down", () => {
	it("fail at once with an OfflineError instead of queueing until the reconnect", async () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		const client = make();
		client.connect();
		FakeSocket.last?.hello();
		FakeSocket.last?.onclose?.({ code: 1006 });
		expect(client.state).toBe("closed");
		const started = Date.now();
		await expect(client.rpc("settings.get", {})).rejects.toBeInstanceOf(OfflineError);
		expect(Date.now() - started).toBeLessThan(500);
		client.close();
	});

	it("give up after a bounded wait when the connection never comes up", async () => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeSocket);
		const client = make();
		client.connect();
		const result = client.rpc("settings.get", {}).then(() => "ok", (e: unknown) => e);
		await vi.advanceTimersByTimeAsync(9_000);
		expect(await result).toBeInstanceOf(OfflineError);
		client.close();
	});

	it("go through once the socket is open", async () => {
		vi.stubGlobal("WebSocket", FakeSocket);
		const client = make();
		client.connect();
		const pending = client.rpc("settings.get", {});
		FakeSocket.last?.hello();
		await Promise.resolve();
		await Promise.resolve();
		const sent = JSON.parse(FakeSocket.last?.sent.at(-1) ?? "{}");
		expect(sent.type).toBe("rpc");
		FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "response", id: sent.id, ok: true, data: { done: 1 } }) });
		await expect(pending).resolves.toEqual({ done: 1 });
		client.close();
	});
});
