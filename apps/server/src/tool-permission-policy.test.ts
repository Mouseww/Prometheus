import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { PermissionRuleRepository } from "./permission-rule-repository.js";
import { ToolPermissionPolicy } from "./tool-permission-policy.js";

const databases = [] as ReturnType<typeof openDatabase>[];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("ToolPermissionPolicy", () => {
  it("allows a simple shell command that matches an allow rule", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const rules = new PermissionRuleRepository(database);
    const allow = rules.create({ toolName: "shell_command", effect: "allow", pattern: "pnpm test*" });

    expect(new ToolPermissionPolicy(rules).evaluate("shell_command", "pnpm test --filter server"))
      .toEqual({ decision: "allow", rules: [allow] });
  });

  it("evaluates matching rules in deny, ask, allow precedence order", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const rules = new PermissionRuleRepository(database);
    rules.create({ toolName: "shell_command", effect: "allow", pattern: "git *" });
    rules.create({ toolName: "shell_command", effect: "ask", pattern: "git push *" });
    const deny = rules.create({ toolName: "shell_command", effect: "deny", pattern: "git push origin main" });
    const policy = new ToolPermissionPolicy(rules);

    expect(policy.evaluate("shell_command", "git push origin main"))
      .toEqual({ decision: "deny", rules: [deny] });
    rules.delete(deny.id);
    expect(policy.evaluate("shell_command", "git push origin main")).toMatchObject({ decision: "ask" });
  });

  it("requires every subcommand in a compound shell command to match an allow rule", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const rules = new PermissionRuleRepository(database);
    const pnpm = rules.create({ toolName: "shell_command", effect: "allow", pattern: "pnpm test*" });
    const policy = new ToolPermissionPolicy(rules);

    expect(policy.evaluate("shell_command", "pnpm test && git status"))
      .toEqual({ decision: "ask", rules: [] });

    const git = rules.create({ toolName: "shell_command", effect: "allow", pattern: "git status" });
    expect(policy.evaluate("shell_command", "pnpm test && git status"))
      .toEqual({ decision: "allow", rules: [pnpm, git] });
  });

  it("falls back to ask for complex shell syntax while preserving explicit denies", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const rules = new PermissionRuleRepository(database);
    rules.create({ toolName: "shell_command", effect: "allow", pattern: "echo *" });
    const deny = rules.create({ toolName: "shell_command", effect: "deny", pattern: "rm *" });
    const policy = new ToolPermissionPolicy(rules);

    expect(policy.evaluate("shell_command", "echo $(whoami)"))
      .toEqual({ decision: "ask", rules: [] });
    expect(policy.evaluate("shell_command", "echo $(whoami) && rm -rf build"))
      .toEqual({ decision: "deny", rules: [deny] });
    expect(policy.evaluate("shell_command", "echo 'safe && quoted'"))
      .toMatchObject({ decision: "allow" });
  });

  it("requires an exact allow rule for commands delegated to another shell", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const rules = new PermissionRuleRepository(database);
    rules.create({ toolName: "shell_command", effect: "allow", pattern: "cmd /c *" });
    const policy = new ToolPermissionPolicy(rules);
    const command = "cmd /c \"echo safe & echo nested\"";

    expect(policy.evaluate("shell_command", command)).toEqual({ decision: "ask", rules: [] });
    const exact = rules.create({ toolName: "shell_command", effect: "allow", pattern: command });
    expect(policy.evaluate("shell_command", command)).toEqual({ decision: "allow", rules: [exact] });
  });
});
