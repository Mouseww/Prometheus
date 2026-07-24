import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  permissionRuleSchema,
  type CreatePermissionRuleInput,
  type PermissionRule,
} from "@prometheus/protocol";

export class PermissionRuleRepository {
  constructor(private readonly database: DatabaseSync) {}

  create(input: CreatePermissionRuleInput): PermissionRule {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO permission_rules (id, tool_name, effect, pattern, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.toolName, input.effect, input.pattern, createdAt);
    return this.get(id)!;
  }

  list(): PermissionRule[] {
    return (this.database.prepare(`
      SELECT * FROM permission_rules
      ORDER BY CASE effect WHEN 'deny' THEN 0 WHEN 'ask' THEN 1 ELSE 2 END,
        created_at ASC, id ASC
    `).all() as unknown as PermissionRuleRow[]).map(mapPermissionRule);
  }

  get(id: string): PermissionRule | undefined {
    const row = this.database.prepare("SELECT * FROM permission_rules WHERE id = ?")
      .get(id) as unknown as PermissionRuleRow | undefined;
    return row ? mapPermissionRule(row) : undefined;
  }

  delete(id: string): boolean {
    return this.database.prepare("DELETE FROM permission_rules WHERE id = ?").run(id).changes > 0;
  }
}

interface PermissionRuleRow {
  id: string;
  tool_name: string;
  effect: string;
  pattern: string;
  created_at: string;
}

function mapPermissionRule(row: PermissionRuleRow): PermissionRule {
  return permissionRuleSchema.parse({
    id: row.id,
    toolName: row.tool_name,
    effect: row.effect,
    pattern: row.pattern,
    createdAt: row.created_at,
  });
}
