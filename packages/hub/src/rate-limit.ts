export interface RateResult {
	allowed: boolean;
	/** Seconds until the window resets (meaningful when not allowed). */
	retryAfterSec: number;
}

interface Bucket {
	count: number;
	resetAt: number;
}

/** In-memory fixed-window counter, single instance only (spec section 4). Keys are caller-namespaced. */
export class RateLimiter {
	readonly #buckets = new Map<string, Bucket>();
	readonly #now: () => number;
	#lastSweep = 0;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Counts one attempt against `key`; returns whether it is within `limit` per `windowMs`. */
	hit(key: string, limit: number, windowMs = 60_000): RateResult {
		const now = this.#now();
		this.#sweep(now);
		let bucket = this.#buckets.get(key);
		if (!bucket || now >= bucket.resetAt) {
			bucket = { count: 0, resetAt: now + windowMs };
			this.#buckets.set(key, bucket);
		}
		bucket.count += 1;
		return { allowed: bucket.count <= limit, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
	}

	/** Drops expired buckets at most once a minute so memory stays bounded. */
	#sweep(now: number): void {
		if (now - this.#lastSweep < 60_000) return;
		this.#lastSweep = now;
		for (const [key, b] of this.#buckets) if (now >= b.resetAt) this.#buckets.delete(key);
	}
}
