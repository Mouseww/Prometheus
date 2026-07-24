import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "./workspace-service.js";
import { WorkspaceToolRegistry } from "./workspace-tools.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceToolRegistry", () => {
  it("exposes a read-only capability set without write_file", () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-tools-"));
    roots.push(root);
    const registry = new WorkspaceToolRegistry(new WorkspaceService(root));

    expect(registry.readonly().map((tool) => tool.definition.name)).toEqual([
      "list_directory",
      "read_file",
      "search_text",
    ]);
    expect(registry.list().map((tool) => tool.definition.name)).toEqual([
      "list_directory",
      "read_file",
      "search_text",
      "write_file",
    ]);
  });

  it("reads a real text file through the read_file tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-tools-"));
    roots.push(root);
    writeFileSync(join(root, "README.md"), "# Verified workspace\n", "utf8");
    const registry = new WorkspaceToolRegistry(new WorkspaceService(root));
    const readFile = registry.list().find((tool) => tool.definition.name === "read_file");

    await expect(readFile?.execute(
      { path: "README.md" },
      new AbortController().signal,
    )).resolves.toEqual({ content: "# Verified workspace\n", isError: false });
  });

  it("lists real workspace entries while preserving relative paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-tools-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export {};\n", "utf8");
    const registry = new WorkspaceToolRegistry(new WorkspaceService(root));
    const listDirectory = registry.list().find((tool) => tool.definition.name === "list_directory");

    await expect(listDirectory?.execute(
      { path: "src" },
      new AbortController().signal,
    )).resolves.toEqual({ content: "file\tsrc/index.ts", isError: false });
  });

  it("searches text recursively and ignores dependency directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-tools-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src", "agent.ts"), "export const runtimeMarker = true;\n", "utf8");
    writeFileSync(join(root, "node_modules", "ignored.ts"), "runtimeMarker\n", "utf8");
    const registry = new WorkspaceToolRegistry(new WorkspaceService(root));
    const searchText = registry.list().find((tool) => tool.definition.name === "search_text");

    await expect(searchText?.execute(
      { query: "runtimeMarker", path: "" },
      new AbortController().signal,
    )).resolves.toEqual({
      content: "src/agent.ts:1: export const runtimeMarker = true;",
      isError: false,
    });
  });

  it("rejects paths that escape the workspace root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "prometheus-tools-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    mkdirSync(root);
    writeFileSync(join(parent, "secret.txt"), "outside", "utf8");
    const registry = new WorkspaceToolRegistry(new WorkspaceService(root));
    const readFile = registry.list().find((tool) => tool.definition.name === "read_file")!;

    await expect(readFile.execute(
      { path: "../secret.txt" },
      new AbortController().signal,
    )).rejects.toThrow("Path escapes workspace root");
  });

  it("rejects binary files and marks truncated text output", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-tools-"));
    roots.push(root);
    writeFileSync(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, "large.txt"), "x".repeat(65_537), "utf8");
    const registry = new WorkspaceToolRegistry(new WorkspaceService(root));
    const readFile = registry.list().find((tool) => tool.definition.name === "read_file")!;

    await expect(readFile.execute(
      { path: "binary.dat" },
      new AbortController().signal,
    )).rejects.toThrow("Binary files are not supported");
    await expect(readFile.execute(
      { path: "large.txt" },
      new AbortController().signal,
    )).resolves.toMatchObject({
      isError: false,
      content: expect.stringContaining("[Output truncated at 65536 bytes]"),
    });
  });

  it("registers an approval-gated write_file tool with a secret-safe summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-tools-"));
    roots.push(root);
    mkdirSync(join(root, "notes"));
    const registry = new WorkspaceToolRegistry(new WorkspaceService(root));
    const writeFile = registry.list().find((tool) => tool.definition.name === "write_file")!;
    const content = "approved content that must not be copied in full";

    expect(writeFile.approval).toBe("always");
    const summary = writeFile.summarizeArguments?.({ path: "notes/result.txt", content });
    expect(summary).toMatchObject({
      path: "notes/result.txt",
      contentBytes: Buffer.byteLength(content, "utf8"),
      contentPreview: content.slice(0, -1),
      contentPreviewTruncated: true,
      contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(summary)).not.toContain(content);
    await expect(writeFile.execute(
      { path: "notes/result.txt", content },
      new AbortController().signal,
    )).resolves.toEqual({
      content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to notes/result.txt`,
      isError: false,
    });
    expect(readFileSync(join(root, "notes", "result.txt"), "utf8")).toBe(content);
  });
});
