import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit.ts";

describe("RateLimiter", () => {
	it("allows up to the limit then blocks until the window resets", () => {
		let t = 1_000_000;
		const rl = new RateLimiter(() => t);
		for (let i = 0; i < 5; i++) expect(rl.hit("k", 5).allowed).toBe(true);
		const blocked = rl.hit("k", 5);
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterSec).toBeGreaterThan(0);
		expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
		t += 60_001;
		expect(rl.hit("k", 5).allowed).toBe(true);
	});

	it("keeps keys independent", () => {
		const rl = new RateLimiter(() => 0);
		for (let i = 0; i < 3; i++) rl.hit("a", 2);
		expect(rl.hit("a", 2).allowed).toBe(false);
		expect(rl.hit("b", 2).allowed).toBe(true);
	});
});
