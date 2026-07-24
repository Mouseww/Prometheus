import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShellCommandTool } from "./shell-command-tool.js";
import { WorkspaceService } from "./workspace-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ShellCommandTool", () => {
  it("runs a real one-shot command in a workspace directory behind approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-shell-"));
    roots.push(root);
    mkdirSync(join(root, "packages"));
    const tool = new ShellCommandTool(new WorkspaceService(root)).tool();
    const command = process.platform === "win32"
      ? "[Console]::Out.Write('stdout-proof'); [Console]::Error.Write('stderr-proof')"
      : "printf 'stdout-proof'; printf 'stderr-proof' >&2";

    expect(tool.approval).toBe("always");
    await expect(tool.execute(
      { command, workdir: "packages", timeout_ms: 10_000 },
      new AbortController().signal,
    )).resolves.toMatchObject({
      isError: false,
      content: expect.stringMatching(/Exit code: 0[\s\S]*stdout-proof[\s\S]*stderr-proof/),
    });
  });

  it("returns captured output as an error result when the command exits non-zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-shell-"));
    roots.push(root);
    const tool = new ShellCommandTool(new WorkspaceService(root)).tool();
    const command = process.platform === "win32"
      ? "[Console]::Error.Write('failure-proof'); exit 7"
      : "printf 'failure-proof' >&2; exit 7";

    await expect(tool.execute(
      { command },
      new AbortController().signal,
    )).resolves.toMatchObject({
      isError: true,
      content: expect.stringMatching(/Exit code: 7[\s\S]*failure-proof/),
    });
  });

  it("terminates a command at the configured timeout and reports the reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-shell-"));
    roots.push(root);
    const tool = new ShellCommandTool(new WorkspaceService(root)).tool();
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
    const startedAt = Date.now();

    await expect(tool.execute(
      { command, timeout_ms: 100 },
      new AbortController().signal,
    )).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("Command timed out after 100 ms"),
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("keeps only the tail of oversized output and reports the original byte count", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-shell-"));
    roots.push(root);
    const tool = new ShellCommandTool(new WorkspaceService(root)).tool();
    const command = process.platform === "win32"
      ? "[Console]::Out.Write(('a' * 70000) + 'tail-proof')"
      : "printf '%070000d' 0; printf 'tail-proof'";

    const result = await tool.execute({ command }, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Output truncated; showing last 65536 of 70010 UTF-8 bytes");
    expect(result.content).toContain("tail-proof");
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(67_000);
  });

  it("does not inherit control-plane secret environment variables", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-shell-"));
    roots.push(root);
    const previousMasterKey = process.env.PROMETHEUS_MASTER_KEY;
    process.env.PROMETHEUS_MASTER_KEY = "must-not-reach-child";
    try {
      const tool = new ShellCommandTool(new WorkspaceService(root)).tool();
      const command = process.platform === "win32"
        ? "if ($env:PROMETHEUS_MASTER_KEY) { [Console]::Out.Write($env:PROMETHEUS_MASTER_KEY) } else { [Console]::Out.Write('secret-filtered') }"
        : "if [ -n \"$PROMETHEUS_MASTER_KEY\" ]; then printf \"$PROMETHEUS_MASTER_KEY\"; else printf 'secret-filtered'; fi";

      const result = await tool.execute({ command }, new AbortController().signal);

      expect(result.content).toContain("secret-filtered");
      expect(result.content).not.toContain("must-not-reach-child");
    } finally {
      if (previousMasterKey === undefined) delete process.env.PROMETHEUS_MASTER_KEY;
      else process.env.PROMETHEUS_MASTER_KEY = previousMasterKey;
    }
  });

  it("honors an already-aborted run signal without waiting for the command timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-shell-"));
    roots.push(root);
    const tool = new ShellCommandTool(new WorkspaceService(root)).tool();
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5";
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();

    await expect(tool.execute({ command }, controller.signal)).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("Command aborted"),
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("redacts common inline secrets from the durable approval summary", () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-shell-"));
    roots.push(root);
    const tool = new ShellCommandTool(new WorkspaceService(root)).tool();
    const command = "SERVICE_TOKEN=token-value deploy --api-key key-value -H 'Authorization: Bearer auth-value'";

    const summary = tool.summarizeArguments?.({ command, workdir: "", timeout_ms: 12_000 });

    expect(summary).toMatchObject({
      command: expect.stringContaining("SERVICE_TOKEN=[redacted]"),
      workdir: "",
      timeoutMs: 12_000,
    });
    expect(JSON.stringify(summary)).not.toMatch(/token-value|key-value|auth-value/);
  });
});
