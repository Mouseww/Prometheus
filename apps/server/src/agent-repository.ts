import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type AgentProfile,
  type CreateAgentProfileInput,
  type UpdateAgentProfileInput,
  agentProfileSchema,
} from "@prometheus/protocol";

interface AgentRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  provider_id: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export class AgentRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: CreateAgentProfileInput): AgentProfile {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO agent_profiles (
        id, name, description, system_prompt, provider_id, model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.description, input.systemPrompt, input.providerId, input.model, now, now);
    return this.get(id)!;
  }

  list(): AgentProfile[] {
    return (this.database.prepare("SELECT * FROM agent_profiles ORDER BY created_at ASC").all() as unknown as AgentRow[])
      .map(mapAgent);
  }

  get(id: string): AgentProfile | undefined {
    const row = this.database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as unknown as AgentRow | undefined;
    return row ? mapAgent(row) : undefined;
  }

  update(id: string, input: UpdateAgentProfileInput): AgentProfile | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE agent_profiles SET
        name = ?, description = ?, system_prompt = ?, provider_id = ?, model = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? existing.name,
      input.description ?? existing.description,
      input.systemPrompt ?? existing.systemPrompt,
      input.providerId ?? existing.providerId,
      input.model ?? existing.model,
      updatedAt,
      id,
    );
    return this.get(id);
  }
}

function mapAgent(row: AgentRow): AgentProfile {
  return agentProfileSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    providerId: row.provider_id,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
