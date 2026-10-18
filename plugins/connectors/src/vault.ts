import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJsonStore, type JsonStore } from "@prometheus/plugin-sdk";
import type { ConnectionRecord, StoredSecrets } from "./types.ts";

interface VaultFile {
	connections: ConnectionRecord[];
}

const ALGO = "aes-256-gcm";

/** Loads the master key, creating it (owner-only) on first use. */
async function loadKey(path: string): Promise<Buffer> {
	try {
		const key = Buffer.from((await readFile(path, "utf8")).trim(), "base64");
		if (key.length === 32) return key;
		throw new Error("connector key file is corrupt");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const key = randomBytes(32);
	await mkdir(join(path, ".."), { recursive: true });
	// `wx` so two processes racing on first start cannot overwrite each other's key.
	try {
		await writeFile(path, key.toString("base64"), { mode: 0o600, flag: "wx" });
		return key;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return loadKey(path);
		throw err;
	}
}

export function encrypt(key: Buffer, secrets: StoredSecrets): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(ALGO, key, iv);
	const body = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decrypt(key: Buffer, blob: string): StoredSecrets {
	const raw = Buffer.from(blob, "base64");
	const decipher = createDecipheriv(ALGO, key, raw.subarray(0, 12));
	decipher.setAuthTag(raw.subarray(12, 28));
	const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
	return JSON.parse(plain.toString("utf8")) as StoredSecrets;
}

export interface Vault {
	list(): Promise<ConnectionRecord[]>;
	get(id: string): Promise<ConnectionRecord | undefined>;
	secrets(record: ConnectionRecord): Promise<StoredSecrets>;
	add(input: Omit<ConnectionRecord, "id" | "createdAt" | "secret"> & { secrets: StoredSecrets }): Promise<ConnectionRecord>;
	/** Replace secrets/expiry after a token refresh, under the store lock. */
	updateSecrets(id: string, fn: (s: StoredSecrets) => StoredSecrets, expiresAt?: number): Promise<void>;
	patch(id: string, patch: Partial<Pick<ConnectionRecord, "label" | "policy" | "config" | "account">>): Promise<void>;
	remove(id: string): Promise<boolean>;
}

export async function openVault(dir: string): Promise<Vault> {
	const key = await loadKey(join(dir, "vault.key"));
	const store: JsonStore<VaultFile> = createJsonStore<VaultFile>(join(dir, "vault.json"), () => ({ connections: [] }));

	const find = (f: VaultFile, id: string) => {
		const r = f.connections.find((c) => c.id === id);
		if (!r) throw new Error(`连接不存在：${id}`);
		return r;
	};

	return {
		async list() {
			return (await store.read()).connections;
		},
		async get(id) {
			return (await store.read()).connections.find((c) => c.id === id);
		},
		async secrets(record) {
			return decrypt(key, record.secret);
		},
		async add({ secrets, ...rest }) {
			const record: ConnectionRecord = { ...rest, id: randomUUID().slice(0, 8), secret: encrypt(key, secrets), createdAt: new Date().toISOString() };
			await store.update((f) => ({ connections: [...f.connections, record] }));
			return record;
		},
		async updateSecrets(id, fn, expiresAt) {
			await store.update((f) => {
				const r = find(f, id);
				r.secret = encrypt(key, fn(decrypt(key, r.secret)));
				if (expiresAt !== undefined) r.expiresAt = expiresAt;
				return f;
			});
		},
		async patch(id, patch) {
			await store.update((f) => {
				Object.assign(find(f, id), patch);
				return f;
			});
		},
		async remove(id) {
			let found = false;
			await store.update((f) => {
				found = f.connections.some((c) => c.id === id);
				return { connections: f.connections.filter((c) => c.id !== id) };
			});
			return found;
		},
	};
}
