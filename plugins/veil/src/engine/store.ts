/**
 * Placeholder ↔ plaintext store.
 *
 * veil keys the store by a hashed credential so two different API keys never share placeholders.
 * Prometheus is a single-user app whose requests all carry the user's own credentials, so this
 * store keys purely on the plaintext: the same secret always yields the same placeholder, no
 * matter which gateway, model or session it appears in.
 *
 * Keys are SHA-256 of the plaintext, so the on-disk file never holds a secret in a form you can
 * read off. The plaintext side still has to be stored to restore it, and that file lives in the
 * plugin data dir with owner-only permissions.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatPlaceholder, keyedId, MAX_ID_LEN, MIN_ID_LEN, parsePlaceholder } from "./placeholder.ts";

/** Per-install secret: generated on first run, then read back. Owner-only file, never leaves the machine. */
export async function loadOrCreateKey(path: string): Promise<Buffer> {
	try {
		const existing = Buffer.from((await readFile(path, "utf8")).trim(), "hex");
		if (existing.length >= 32) return existing;
	} catch {
		// first run
	}
	const key = randomBytes(32);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, key.toString("hex"), { mode: 0o600 });
	return key;
}

interface Entry {
	/** `{{TYPE_xxxxx}}` as sent upstream. */
	token: string;
	/** The original secret. */
	plaintext: string;
	createdAt: number;
	lastSeen: number;
}

interface File {
	version: 1;
	/** keyed by `plaintextKey(plaintext)`. */
	entries: Record<string, Entry>;
}

export interface StoreOptions {
	path: string;
	/** The install key; every placeholder is derived from it with HMAC, so it must stay stable. */
	key: Buffer;
	/** Entries untouched for this long are dropped on load. 0 disables expiry. */
	ttlDays?: number;
	/** Hard cap; oldest entries are evicted beyond it. */
	cap?: number;
}

export class MappingStore {
	private entries = new Map<string, Entry>();
	private byToken = new Map<string, Entry>();
	private dirty = false;
	private writing: Promise<void> = Promise.resolve();
	private readonly path: string;
	private readonly secret: Buffer;
	private readonly ttlMs: number;
	private readonly cap: number;

	constructor(options: StoreOptions) {
		this.path = options.path;
		this.secret = options.key;
		this.ttlMs = (options.ttlDays ?? 90) > 0 ? (options.ttlDays ?? 90) * 24 * 60 * 60 * 1000 : 0;
		this.cap = options.cap ?? 100_000;
	}

	async load(): Promise<{ loaded: number; evicted: number }> {
		let raw: File;
		try {
			raw = JSON.parse(await readFile(this.path, "utf8")) as File;
		} catch {
			return { loaded: 0, evicted: 0 };
		}
		const now = Date.now();
		let evicted = 0;
		for (const [key, entry] of Object.entries(raw.entries ?? {})) {
			if (!entry?.token || typeof entry.plaintext !== "string" || !parsePlaceholder(entry.token)) {
				evicted++;
				continue;
			}
			if (this.ttlMs > 0 && now - (entry.lastSeen ?? 0) > this.ttlMs) {
				evicted++;
				continue;
			}
			this.entries.set(key, entry);
			this.byToken.set(entry.token, entry);
		}
		if (evicted > 0) this.dirty = true;
		return { loaded: this.entries.size, evicted };
	}

	/** The placeholder for `plaintext`, creating one on first sight. */
	getOrInsert(typePrefix: string, plaintext: string): string {
		const key = this.plaintextKey(typePrefix, plaintext);
		const existing = this.entries.get(key);
		if (existing) {
			existing.lastSeen = Date.now();
			this.dirty = true;
			return existing.token;
		}
		// Deterministic and short; a longer id is used only if a different secret already owns the short one.
		let token = "";
		for (let len = MIN_ID_LEN; len <= MAX_ID_LEN; len++) {
			token = formatPlaceholder({ typePrefix, id: keyedId(this.secret, typePrefix, plaintext, len) });
			const owner = this.byToken.get(token);
			if (!owner || owner.plaintext === plaintext) break;
		}
		const entry: Entry = {
			token,
			plaintext,
			createdAt: Date.now(),
			lastSeen: Date.now(),
		};
		this.entries.set(key, entry);
		this.byToken.set(entry.token, entry);
		this.evict();
		this.dirty = true;
		this.scheduleWrite();
		return entry.token;
	}

	/** Table key: HMAC of type + plaintext, so the file holds nothing that can be checked against a guess without the install key. */
	private plaintextKey(typePrefix: string, plaintext: string): string {
		return createHmac("sha256", this.secret).update("k\u0000").update(typePrefix).update("\u0000").update(plaintext, "utf8").digest("hex").slice(0, 16);
	}

	/** The plaintext a token stands for, or undefined when this table never issued it. */
	lookup(token: string): string | undefined {
		const entry = this.byToken.get(token);
		if (!entry) return undefined;
		entry.lastSeen = Date.now();
		this.dirty = true;
		return entry.plaintext;
	}

	size(): number {
		return this.entries.size;
	}

	/** Recent entries with the plaintext masked, for the panel. */
	preview(limit = 50): { token: string; type: string; masked: string; createdAt: number }[] {
		return [...this.entries.values()]
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit)
			.map((e) => ({ token: e.token, type: e.token.slice(2, e.token.indexOf("_")), masked: mask(e.plaintext), createdAt: e.createdAt }));
	}

	clear(): Promise<void> {
		this.entries.clear();
		this.byToken.clear();
		this.dirty = true;
		return this.scheduleWrite();
	}

	private evict(): void {
		if (this.entries.size <= this.cap) return;
		const sorted = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
		for (const [key, entry] of sorted.slice(0, this.entries.size - this.cap)) {
			this.entries.delete(key);
			this.byToken.delete(entry.token);
		}
	}

	/** Coalesces bursts of inserts into one write. */
	private scheduleWrite(): Promise<void> {
		if (!this.dirty) return this.writing;
		this.dirty = false;
		const snapshot: File = { version: 1, entries: Object.fromEntries(this.entries) };
		const body = JSON.stringify(snapshot);
		const run = async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.tmp`;
			await writeFile(tmp, body, { mode: 0o600 });
			await rename(tmp, this.path);
		};
		this.writing = this.writing.then(run, run);
		return this.writing;
	}

	/** Waits for pending writes; call before shutdown. */
	flush(): Promise<void> {
		if (this.dirty) this.scheduleWrite();
		return this.writing;
	}
}

/** `138****8000` — enough to recognise a row without printing a secret. */
function mask(value: string): string {
	if (value.length <= 8) return "•".repeat(Math.max(4, value.length));
	return `${value.slice(0, 3)}${"•".repeat(Math.min(8, value.length - 7))}${value.slice(-4)}`;
}
