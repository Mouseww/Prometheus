import { expect, it } from "vitest";
import type { SessionEvent } from "@prometheus/protocol";
import { agentShellLines, inputLine, resultLines, systemLine } from "./terminal-model";

it("builds terminal result lines from exec payload", () => {
  const lines = resultLines({
    exitCode: 0,
    durationMs: 12,
    output: "hello",
    totalBytes: 5,
    timedOut: false,
    isError: false,
    command: "echo hello",
    workdir: "",
  });
  expect(lines.some((line) => line.text.includes("exit 0"))).toBe(true);
  expect(lines.some((line) => line.text === "hello")).toBe(true);
  expect(inputLine("echo hi", "apps").text).toContain("apps > echo hi");
  expect(systemLine("ready").kind).toBe("system");
});

it("mirrors agent shell tool events", () => {
  const started = {
    eventId: "e1",
    sessionId: "s1",
    sequence: 1,
    type: "tool.call.started",
    actor: { kind: "tool", id: "shell_command", label: "shell_command" },
    createdAt: "2026-07-26T00:00:00.000Z",
    payload: {
      toolName: "shell_command",
      arguments: { command: "dir", workdir: "" },
    },
  } as SessionEvent;
  const lines = agentShellLines(started);
  expect(lines?.[0]?.text).toContain("[agent]");
  expect(lines?.[0]?.text).toContain("dir");
});
