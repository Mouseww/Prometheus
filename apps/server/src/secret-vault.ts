import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const keyLength = 32;

export class SecretVault {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== keyLength) {
      throw new Error("SecretVault requires a 32-byte key");
    }
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv, tag, ciphertext].map((part) =>
      typeof part === "string" ? part : part.toString("base64url"),
    ).join(":");
  }

  decrypt(envelope: string): string {
    const [version, ivValue, tagValue, ciphertextValue] = envelope.split(":");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
      throw new Error("Invalid secret envelope");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function loadOrCreateMasterKey(filename: string, encodedOverride?: string): Buffer {
  if (encodedOverride) {
    const key = Buffer.from(encodedOverride, "base64");
    if (key.byteLength !== keyLength) {
      throw new Error("PROMETHEUS_MASTER_KEY must decode to exactly 32 bytes");
    }
    return key;
  }

  if (existsSync(filename)) {
    const key = Buffer.from(readFileSync(filename, "utf8").trim(), "base64");
    if (key.byteLength !== keyLength) {
      throw new Error(`Invalid master key file: ${filename}`);
    }
    return key;
  }

  mkdirSync(dirname(filename), { recursive: true });
  const key = randomBytes(keyLength);
  writeFileSync(filename, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
  return key;
}
