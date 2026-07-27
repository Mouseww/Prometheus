import type { SessionEvent } from "@prometheus/protocol";
import type { TerminalExecResult } from "./api";

export type TerminalLine = {
  id: string;
  kind: "system" | "input" | "output" | "agent";
  text: string;
  tone?: "default" | "error" | "success" | "muted";
  createdAt: number;
};

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return prefix + "-" + Date.now().toString(36) + "-" + seq;
}

export function systemLine(text: string, tone: TerminalLine["tone"] = "muted"): TerminalLine {
  return { id: nextId("sys"), kind: "system", text, tone, createdAt: Date.now() };
}

export function inputLine(command: string, workdir: string): TerminalLine {
  const prompt = workdir ? workdir + " > " : "> ";
  return { id: nextId("in"), kind: "input", text: prompt + command, tone: "default", createdAt: Date.now() };
}

export function resultLines(result: TerminalExecResult): TerminalLine[] {
  const lines: TerminalLine[] = [];
  const meta = [
    result.timedOut ? "timed out" : null,
    result.exitCode === null ? "exit null" : "exit " + result.exitCode,
    result.durationMs + " ms",
  ].filter(Boolean).join(" · ");
  lines.push({
    id: nextId("meta"),
    kind: "system",
    text: meta,
    tone: result.isError ? "error" : "success",
    createdAt: Date.now(),
  });
  if (result.output.trim()) {
    lines.push({
      id: nextId("out"),
      kind: "output",
      text: result.output,
      tone: result.isError ? "error" : "default",
      createdAt: Date.now(),
    });
  } else {
    lines.push(systemLine("[empty output]", "muted"));
  }
  return lines;
}

export function agentShellLines(event: SessionEvent): TerminalLine[] | null {
  if (event.type !== "tool.call.started" && event.type !== "tool.call.completed") return null;
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
  if (toolName !== "shell_command") return null;

  if (event.type === "tool.call.started") {
    const args = event.payload.arguments as Record<string, unknown> | undefined;
    const command = typeof args?.command === "string" ? args.command : "(shell)";
    const workdir = typeof args?.workdir === "string" ? args.workdir : "";
    return [
      {
        id: nextId("agent-in"),
        kind: "agent",
        text: "[agent] " + (workdir ? workdir + " > " : "> ") + command,
        tone: "muted",
        createdAt: Date.now(),
      },
    ];
  }

  const output = typeof event.payload.output === "string" ? event.payload.output : "";
  const isError = event.payload.isError === true;
  return [
    {
      id: nextId("agent-out"),
      kind: "agent",
      text: output || (isError ? "[agent shell failed]" : "[agent shell completed]"),
      tone: isError ? "error" : "default",
      createdAt: Date.now(),
    },
  ];
}

export function extractWritePath(event: SessionEvent): string | null {
  if (event.type !== "tool.call.completed") return null;
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
  if (toolName !== "write_file") return null;
  // arguments are only on started; try output text "Wrote ..." or started pairing is complex.
  // Prefer started event path via separate helper.
  return null;
}

export function extractWritePathFromStarted(event: SessionEvent): string | null {
  if (event.type !== "tool.call.started") return null;
  const toolName = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
  if (toolName !== "write_file") return null;
  const args = event.payload.arguments as Record<string, unknown> | undefined;
  return typeof args?.path === "string" ? args.path : null;
}
