import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CreateProviderInput,
  type Provider,
  type ProviderKind,
  type UpdateProviderInput,
  providerSchema,
} from "@prometheus/protocol";
import type { SecretVault } from "./secret-vault.js";

interface ProviderRow {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string | null;
  default_model: string;
  encrypted_api_key: string;
  created_at: string;
  updated_at: string;
}

export interface RuntimeProvider extends Provider {
  apiKey: string;
}

export class ProviderRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly vault: SecretVault,
  ) {}

  create(input: CreateProviderInput): Provider {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO providers (
        id, name, kind, base_url, default_model, encrypted_api_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.kind,
      input.baseUrl ?? null,
      input.defaultModel,
      this.vault.encrypt(input.apiKey),
      now,
      now,
    );
    return this.get(id)!;
  }

  list(): Provider[] {
    return (this.database.prepare("SELECT * FROM providers ORDER BY created_at ASC").all() as unknown as ProviderRow[])
      .map(mapProvider);
  }

  get(id: string): Provider | undefined {
    const row = this.getRow(id);
    return row ? mapProvider(row) : undefined;
  }

  getRuntime(id: string): RuntimeProvider | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    return { ...mapProvider(row), apiKey: this.vault.decrypt(row.encrypted_api_key) };
  }

  update(id: string, input: UpdateProviderInput): Provider | undefined {
    const existing = this.getRow(id);
    if (!existing) return undefined;
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE providers SET
        name = ?, base_url = ?, default_model = ?, encrypted_api_key = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? existing.name,
      input.baseUrl === undefined ? existing.base_url : input.baseUrl,
      input.defaultModel ?? existing.default_model,
      input.apiKey ? this.vault.encrypt(input.apiKey) : existing.encrypted_api_key,
      updatedAt,
      id,
    );
    return this.get(id);
  }

  private getRow(id: string): ProviderRow | undefined {
    return this.database.prepare("SELECT * FROM providers WHERE id = ?").get(id) as unknown as ProviderRow | undefined;
  }
}

function mapProvider(row: ProviderRow): Provider {
  return providerSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    defaultModel: row.default_model,
    hasApiKey: row.encrypted_api_key.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
