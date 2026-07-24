import type {
  PermissionRule,
  PermissionRuleEffect,
  PermissionRuleTool,
} from "@prometheus/protocol";
import type { PermissionRuleRepository } from "./permission-rule-repository.js";

export interface PermissionPolicyEvaluation {
  decision: "allow" | "ask" | "deny";
  rules: PermissionRule[];
}

const precedence: PermissionRuleEffect[] = ["deny", "ask", "allow"];

export class ToolPermissionPolicy {
  constructor(private readonly repository: PermissionRuleRepository) {}

  evaluate(toolName: PermissionRuleTool, target: string): PermissionPolicyEvaluation {
    const rules = this.repository.list().filter((rule) => rule.toolName === toolName);
    const parsed = toolName === "shell_command"
      ? splitShellCommand(target)
      : { segments: [target], complex: false };
    for (const effect of precedence.slice(0, 2)) {
      const matched = matchingRules(rules, effect, parsed.segments);
      if (matched.length > 0) return { decision: effect, rules: matched };
    }
    if (parsed.complex || parsed.segments.length === 0) return { decision: "ask", rules: [] };

    const allowRules = rules.filter((rule) => rule.effect === "allow");
    const matchedAllows: PermissionRule[] = [];
    for (const segment of parsed.segments) {
      const requiresExactRule = toolName === "shell_command" && isShellWrapper(segment);
      const segmentMatches = allowRules.filter((rule) =>
        matchesGlob(rule.pattern, segment) && (!requiresExactRule || !rule.pattern.includes("*")),
      );
      if (segmentMatches.length === 0) return { decision: "ask", rules: [] };
      matchedAllows.push(...segmentMatches);
    }
    return { decision: "allow", rules: uniqueRules(matchedAllows) };
  }
}

function isShellWrapper(command: string): boolean {
  return /^(?:cmd(?:\.exe)?\s+\/(?:c|k)\b|(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*\s-(?:command|encodedcommand)\b|(?:ba|z|k|fi)?sh\s+-(?:c|lc)\b)/i
    .test(command.trim());
}

function matchingRules(
  rules: PermissionRule[],
  effect: PermissionRuleEffect,
  targets: string[],
): PermissionRule[] {
  return uniqueRules(rules.filter((rule) =>
    rule.effect === effect && targets.some((target) => matchesGlob(rule.pattern, target)),
  ));
}

function uniqueRules(rules: PermissionRule[]): PermissionRule[] {
  return [...new Map(rules.map((rule) => [rule.id, rule])).values()];
}

function splitShellCommand(command: string): { segments: string[]; complex: boolean } {
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  let complex = false;
  const push = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      current += character;
      if (character === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      current += character;
      if (character === "\\") escaped = true;
      else if (character === "\"") quote = null;
      else if (character === "`" || (character === "$" && next === "(")) complex = true;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "'") {
      current += character;
      quote = "single";
      continue;
    }
    if (character === "\"") {
      current += character;
      quote = "double";
      continue;
    }
    if (character === "`" || (character === "$" && next === "(") ||
      ((character === "<" || character === ">") && next === "(")) {
      complex = true;
      current += character;
      continue;
    }
    const twoCharacterOperator = (character === "&" && next === "&") ||
      (character === "|" && (next === "|" || next === "&"));
    if (twoCharacterOperator) {
      push();
      index += 1;
      continue;
    }
    if (character === ";" || character === "|" || character === "&" || character === "\n") {
      push();
      continue;
    }
    current += character;
  }
  push();
  if (quote !== null || escaped) complex = true;
  return { segments, complex };
}

function matchesGlob(pattern: string, target: string): boolean {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "").test(target);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
