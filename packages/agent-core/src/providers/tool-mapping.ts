import type { ToolCall } from "../types.js";

export function parseToolArguments(value: string): ToolCall["arguments"] {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Provider returned invalid tool arguments");
  }
  return parsed as ToolCall["arguments"];
}
