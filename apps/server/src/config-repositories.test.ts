import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "./agent-repository.js";
import { openDatabase } from "./database.js";
import { ProviderRepository } from "./provider-repository.js";
import { SecretVault } from "./secret-vault.js";

const databases = [] as ReturnType<typeof openDatabase>[];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("configuration repositories", () => {
  it("stores encrypted provider secrets and returns safe read models", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const providers = new ProviderRepository(database, new SecretVault(randomBytes(32)));
    const provider = providers.create({
      name: "OpenAI",
      kind: "openai",
      defaultModel: "gpt-model",
      apiKey: "plain-secret",
    });

    expect(provider.hasApiKey).toBe(true);
    expect(Object.hasOwn(provider, "apiKey")).toBe(false);
    expect(providers.getRuntime(provider.id)?.apiKey).toBe("plain-secret");
    const stored = database.prepare("SELECT encrypted_api_key FROM providers WHERE id = ?").get(provider.id) as { encrypted_api_key: string };
    expect(stored.encrypted_api_key).not.toContain("plain-secret");
  });

  it("creates agent profiles referencing a real provider", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const providers = new ProviderRepository(database, new SecretVault(randomBytes(32)));
    const provider = providers.create({ name: "Anthropic", kind: "anthropic", defaultModel: "claude-model", apiKey: "secret" });
    const agents = new AgentRepository(database);
    const agent = agents.create({
      name: "Builder",
      description: "Implements scoped changes",
      systemPrompt: "Work carefully and report evidence.",
      providerId: provider.id,
      model: provider.defaultModel,
    });

    expect(agents.get(agent.id)).toEqual(agent);
  });
});
