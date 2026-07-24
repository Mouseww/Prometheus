import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { PermissionRuleRepository } from "./permission-rule-repository.js";

const databases = [] as ReturnType<typeof openDatabase>[];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("PermissionRuleRepository", () => {
  it("persists and lists node permission rules in precedence order", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const repository = new PermissionRuleRepository(database);

    const allow = repository.create({ toolName: "shell_command", effect: "allow", pattern: "pnpm test*" });
    const deny = repository.create({ toolName: "shell_command", effect: "deny", pattern: "git push *" });
    const ask = repository.create({ toolName: "write_file", effect: "ask", pattern: "secrets/*" });

    expect(repository.list()).toEqual([deny, ask, allow]);
    expect(repository.get(deny.id)).toEqual(deny);
  });
});
