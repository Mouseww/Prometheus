import { describe, expect, it, vi } from "vitest";
import { detectHubMode, inviteTokenFromPath, isHubRole } from "../src/team/hubMode.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("detectHubMode", () => {
	it("is true only when /api/health reports role hub", async () => {
		const f = vi.fn(async () => json({ ok: true, role: "hub" }));
		await expect(detectHubMode(f as unknown as typeof fetch)).resolves.toBe(true);
		expect(f.mock.calls[0]?.[0]).toBe("/api/health");
		await expect(detectHubMode((async () => json({ ok: true, role: "server" })) as unknown as typeof fetch)).resolves.toBe(false);
		await expect(detectHubMode((async () => json({ ok: true })) as unknown as typeof fetch)).resolves.toBe(false);
	});

	it("is false for failures, non-ok replies and junk", async () => {
		await expect(
			detectHubMode((async () => {
				throw new TypeError("offline");
			}) as unknown as typeof fetch),
		).resolves.toBe(false);
		await expect(detectHubMode((async () => json({ role: "hub" }, 500)) as unknown as typeof fetch)).resolves.toBe(false);
		await expect(detectHubMode((async () => new Response("<html>")) as unknown as typeof fetch)).resolves.toBe(false);
	});

	it("gives up after the timeout", async () => {
		vi.useFakeTimers();
		try {
			const f = ((_url: string, init?: RequestInit) =>
				new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
			const p = detectHubMode(f, 1000);
			await vi.advanceTimersByTimeAsync(1000);
			await expect(p).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("isHubRole", () => {
	it("rejects non-objects", () => {
		expect(isHubRole(null)).toBe(false);
		expect(isHubRole("hub")).toBe(false);
		expect(isHubRole({ role: "hub" })).toBe(true);
	});
});

describe("inviteTokenFromPath", () => {
	it("extracts the token of /invite/<token>", () => {
		expect(inviteTokenFromPath("/invite/abc123")).toBe("abc123");
		expect(inviteTokenFromPath("/invite/abc%2B123/")).toBe("abc+123");
		expect(inviteTokenFromPath("/")).toBeUndefined();
		expect(inviteTokenFromPath("/invite/")).toBeUndefined();
		expect(inviteTokenFromPath("/other/abc")).toBeUndefined();
		expect(inviteTokenFromPath("/invite/%E0%A4%A")).toBeUndefined();
	});
});
