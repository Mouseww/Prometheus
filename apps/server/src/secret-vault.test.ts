import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretVault } from "./secret-vault.js";

describe("SecretVault", () => {
  it("round-trips secrets with unique authenticated envelopes", () => {
    const vault = new SecretVault(randomBytes(32));
    const first = vault.encrypt("provider-secret");
    const second = vault.encrypt("provider-secret");

    expect(first).not.toBe(second);
    expect(vault.decrypt(first)).toBe("provider-secret");
    expect(vault.decrypt(second)).toBe("provider-secret");
  });

  it("rejects tampered ciphertext", () => {
    const vault = new SecretVault(randomBytes(32));
    const envelope = vault.encrypt("provider-secret");
    const tampered = `${envelope.slice(0, -1)}${envelope.endsWith("A") ? "B" : "A"}`;

    expect(() => vault.decrypt(tampered)).toThrow();
  });
});
