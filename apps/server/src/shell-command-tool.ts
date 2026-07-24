import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { AgentTool } from "@prometheus/agent-core";
import { z } from "zod";
import type { WorkspaceService } from "./workspace-service.js";

const shellCommandInputSchema = z.object({
  command: z.string().trim().min(1).max(20_000),
  workdir: z.string().trim().max(2_048).default(""),
  timeout_ms: z.number().int().min(100).max(120_000).default(10_000),
});
const MAX_OUTPUT_BYTES = 64 * 1024;

export class ShellCommandTool {
  constructor(private readonly workspace: WorkspaceService) {}

  tool(): AgentTool {
    return {
      approval: "always",
      definition: {
        name: "shell_command",
        description: "Run a one-shot shell command inside the workspace after user approval.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
            workdir: {
              type: "string",
              description: "Workspace-relative working directory; empty means workspace root",
            },
            timeout_ms: {
              type: "integer",
              minimum: 100,
              maximum: 120_000,
              description: "Maximum runtime in milliseconds; defaults to 10000",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      summarizeArguments: (argumentsValue) => {
        const parsed = shellCommandInputSchema.parse(argumentsValue);
        return {
          command: redactCommandSecrets(parsed.command),
          workdir: parsed.workdir,
          timeoutMs: parsed.timeout_ms,
        };
      },
      permissionTarget: (argumentsValue) => shellCommandInputSchema.parse(argumentsValue).command,
      execute: async (argumentsValue, signal) => {
        const input = shellCommandInputSchema.parse(argumentsValue);
        const cwd = this.workspace.resolveDirectory(input.workdir);
        return executeShellCommand(input.command, cwd, input.timeout_ms, signal);
      },
    };
  }
}

async function executeShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  const startedAt = performance.now();
  if (signal.aborted) {
    return {
      content: formatResult(null, 0, Buffer.alloc(0), 0, "Command aborted"),
      isError: true,
    };
  }
  const shell = resolveShell();
  const child = spawn(shell.executable, [...shell.arguments, command], {
    cwd,
    detached: process.platform !== "win32",
    env: createShellEnvironment(process.env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputTail = Buffer.alloc(0);
  let totalOutputBytes = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const appendOutput = (chunk: string) => {
    const bytes = Buffer.from(sanitizeOutput(chunk), "utf8");
    totalOutputBytes += bytes.length;
    outputTail = Buffer.concat([outputTail, bytes]);
    if (outputTail.length > MAX_OUTPUT_BYTES) outputTail = outputTail.subarray(-MAX_OUTPUT_BYTES);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  return new Promise((resolve) => {
    let terminationReason: string | undefined;
    const timeout = setTimeout(() => {
      terminationReason = `Command timed out after ${timeoutMs} ms`;
      terminateProcessTree(child.pid, child.kill.bind(child));
    }, timeoutMs);
    const abort = () => {
      terminationReason = "Command aborted";
      terminateProcessTree(child.pid, child.kill.bind(child));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve({
        content: formatResult(
          null,
          performance.now() - startedAt,
          outputTail,
          totalOutputBytes,
          error.message,
        ),
        isError: true,
      });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve({
        content: formatResult(
          exitCode,
          performance.now() - startedAt,
          outputTail,
          totalOutputBytes,
          terminationReason,
        ),
        isError: terminationReason !== undefined || exitCode !== 0,
      });
    });
  });
}

function resolveShell(): { executable: string; arguments: string[] } {
  if (process.platform === "win32") {
    return { executable: "powershell.exe", arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] };
  }
  return { executable: process.env.SHELL || "/bin/sh", arguments: ["-lc"] };
}

function terminateProcessTree(pid: number | undefined, fallback: () => boolean): void {
  if (!pid) {
    fallback();
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", fallback);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    fallback();
  }
}

function createShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) => {
      if (value === undefined) return false;
      if (name.toUpperCase().startsWith("PROMETHEUS_")) return false;
      return !/(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|CREDENTIAL)/i.test(name);
    }),
  );
}

function formatResult(
  exitCode: number | null,
  elapsedMs: number,
  outputTail: Buffer,
  totalOutputBytes: number,
  error?: string,
): string {
  const output = outputTail.toString("utf8");
  const truncated = totalOutputBytes > outputTail.length;
  const body = output || "(no output)";
  return [
    `Exit code: ${exitCode ?? "unavailable"}`,
    `Wall time: ${(elapsedMs / 1_000).toFixed(3)}s`,
    error ? `Error: ${error}` : null,
    truncated
      ? `Output truncated; showing last ${outputTail.length} of ${totalOutputBytes} UTF-8 bytes`
      : null,
    "Output:",
    body,
  ].filter((line) => line !== null).join("\n");
}

function sanitizeOutput(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0);
      if (code === undefined) return false;
      return code === 0x09 || code === 0x0a || code === 0x0d || code > 0x1f;
    })
    .join("");
}

function redactCommandSecrets(command: string): string {
  return command
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /(--(?:api[-_]?key|token|secret|password|passwd|credential)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
      "$1[redacted]",
    )
    .replace(/(Authorization\s*:\s*(?:Bearer\s+)?)([^'"\s;]+)/gi, "$1[redacted]");
}
