import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPair } from "./jwt.ts";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, keylen, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
	});
}

/** `scrypt$N$r$p$salt$hash` (salt and hash base64url); parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN);
	return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
	const expected = Buffer.from(hash, "base64url");
	try {
		const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p), expected.length);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

/** Burns the same time as a real check so unknown emails are not distinguishable by latency. */
export async function dummyPasswordCheck(): Promise<void> {
	await scryptAsync("dummy-password", Buffer.alloc(16), SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN);
}

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export function constantTimeEquals(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** AES-256-GCM box for secrets at rest (gateway keys, upstream tokens). Format `v1:iv:tag:ciphertext`, all base64url. */
export class SecretBox {
	readonly #key: Buffer;

	constructor(key: Buffer) {
		if (key.length !== 32) throw new Error("主密钥必须是 32 字节");
		this.#key = key;
	}

	seal(plain: string): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
		return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
	}

	open(sealed: string): string {
		const parts = sealed.split(":");
		if (parts.length !== 4 || parts[0] !== "v1") throw new Error("密文格式无效");
		const [, iv, tag, ct] = parts as [string, string, string, string];
		const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
		decipher.setAuthTag(Buffer.from(tag, "base64url"));
		return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
	}
}

async function writeSecretFile(path: string, content: string): Promise<void> {
	await writeFile(path, content, { mode: 0o600 });
	// Windows ignores POSIX modes; the chmod is best effort there.
	await chmod(path, 0o600).catch(() => {});
}

async function readIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** Master key from HUB_SECRET_KEY (32 bytes, base64) or a generated `<dataDir>/secret.key` (0600). */
export async function loadMasterKey(dataDir: string, envKey?: string): Promise<Buffer> {
	if (envKey) {
		const key = Buffer.from(envKey.trim(), "base64");
		if (key.length !== 32) throw new Error("HUB_SECRET_KEY 必须是 32 字节的 base64 字符串");
		return key;
	}
	await mkdir(dataDir, { recursive: true });
	const path = join(dataDir, "secret.key");
	const existing = await readIfExists(path);
	if (existing) {
		const key = Buffer.from(existing.trim(), "base64");
		if (key.length !== 32) throw new Error(`${path} 内容无效，应为 32 字节的 base64`);
		return key;
	}
	const key = randomBytes(32);
	await writeSecretFile(path, key.toString("base64"));
	return key;
}

export interface JwtKeys {
	privateKey: string;
	publicKey: string;
}

/** Ed25519 signing key at `<dataDir>/jwt.key` (PEM, 0600); the public half is derived from it. */
export async function loadJwtKeys(dataDir: string): Promise<JwtKeys> {
	await mkdir(dataDir, { recursive: true });
	const path = join(dataDir, "jwt.key");
	let privateKey = await readIfExists(path);
	if (!privateKey) {
		privateKey = generateKeyPair().privateKey;
		await writeSecretFile(path, privateKey);
	}
	const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
	return { privateKey, publicKey };
}
