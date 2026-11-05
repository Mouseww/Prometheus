import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword, loadJwtKeys, loadMasterKey, SecretBox, verifyPassword } from "../src/crypto.ts";
import { signJwt, verifyJwt } from "../src/jwt.ts";
import { tempDir } from "./helpers.ts";

describe("password hashing", () => {
	it("uses the scrypt$N$r$p$salt$hash format and verifies", async () => {
		const h = await hashPassword("s3cret-pass");
		const parts = h.split("$");
		expect(parts.slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
		expect(Buffer.from(parts[5] as string, "base64url")).toHaveLength(64);
		expect(await verifyPassword("s3cret-pass", h)).toBe(true);
		expect(await verifyPassword("S3cret-pass", h)).toBe(false);
		expect(await hashPassword("s3cret-pass")).not.toBe(h);
	});
	it("rejects malformed hashes without throwing", async () => {
		expect(await verifyPassword("x", "plain")).toBe(false);
		expect(await verifyPassword("x", "bcrypt$1$2$3$4$5")).toBe(false);
		expect(await verifyPassword("x", "scrypt$abc$8$1$AAAA$BBBB")).toBe(false);
	});
});

describe("SecretBox", () => {
	const box = new SecretBox(randomBytes(32));
	it("round-trips and uses a fresh IV each time", () => {
		const a = box.seal("sk-live-123 中文");
		expect(a.startsWith("v1:")).toBe(true);
		expect(a).not.toContain("sk-live");
		expect(box.open(a)).toBe("sk-live-123 中文");
		expect(box.seal("x")).not.toBe(box.seal("x"));
	});
	it("detects tampering and wrong keys", () => {
		const sealed = box.seal("secret");
		const parts = sealed.split(":");
		parts[3] = Buffer.from("tampered!").toString("base64url");
		expect(() => box.open(parts.join(":"))).toThrow();
		expect(() => new SecretBox(randomBytes(32)).open(sealed)).toThrow();
		expect(() => box.open("garbage")).toThrow();
		expect(() => new SecretBox(randomBytes(16))).toThrow(/32/);
	});
});

describe("key files", () => {
	it("generates secret.key once with owner-only permissions and reuses it", async () => {
		const dir = await tempDir();
		const k1 = await loadMasterKey(dir);
		expect(k1).toHaveLength(32);
		const k2 = await loadMasterKey(dir);
		expect(k2.equals(k1)).toBe(true);
		if (process.platform !== "win32") expect((await stat(join(dir, "secret.key"))).mode & 0o777).toBe(0o600);
	});
	it("prefers HUB_SECRET_KEY and validates its length", async () => {
		const dir = await tempDir();
		const key = randomBytes(32);
		expect((await loadMasterKey(dir, key.toString("base64"))).equals(key)).toBe(true);
		await expect(loadMasterKey(dir, Buffer.alloc(8).toString("base64"))).rejects.toThrow(/32/);
		await writeFile(join(dir, "secret.key"), "AAAA");
		await expect(loadMasterKey(dir)).rejects.toThrow(/无效/);
	});
	it("creates jwt.key and signs tokens verifiable with the derived public key", async () => {
		const dir = await tempDir();
		const keys = await loadJwtKeys(dir);
		expect(await readFile(join(dir, "jwt.key"), "utf8")).toContain("PRIVATE KEY");
		if (process.platform !== "win32") expect((await stat(join(dir, "jwt.key"))).mode & 0o777).toBe(0o600);
		const again = await loadJwtKeys(dir);
		expect(again.publicKey).toBe(keys.publicKey);
		const iat = Math.floor(Date.now() / 1000);
		const token = signJwt({ sub: "u", iat, exp: iat + 60 }, keys.privateKey);
		expect(verifyJwt(token, { publicKey: keys.publicKey })?.sub).toBe("u");
	});
});
