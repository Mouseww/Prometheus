import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "./workspace-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkspaceService", () => {
  it("lists real directories before files and omits heavy internal directories", () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-workspace-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "README.md"), "# fixture");

    expect(new WorkspaceService(root).list()).toEqual([
      { kind: "directory", name: "src", path: "src" },
      { kind: "file", name: "README.md", path: "README.md" },
    ]);
  });

  it("rejects traversal outside the configured root", () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-workspace-"));
    roots.push(root);
    const service = new WorkspaceService(root);

    expect(() => service.list("..")).toThrow();
  });

  it("resolves only existing directories inside the workspace for command execution", () => {
    const parent = mkdtempSync(join(tmpdir(), "prometheus-workspace-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    mkdirSync(root);
    mkdirSync(join(root, "packages"));
    writeFileSync(join(root, "README.md"), "# fixture");
    const service = new WorkspaceService(root);

    expect(service.resolveDirectory("")).toBe(root);
    expect(service.resolveDirectory("packages")).toBe(join(root, "packages"));
    expect(() => service.resolveDirectory("README.md")).toThrow("Path is not a directory");
    expect(() => service.resolveDirectory("..")).toThrow("Path escapes workspace root");
  });

  it("writes a UTF-8 file only inside an existing workspace directory", () => {
    const root = mkdtempSync(join(tmpdir(), "prometheus-workspace-"));
    roots.push(root);
    mkdirSync(join(root, "notes"));
    const service = new WorkspaceService(root);

    expect(service.writeTextFile("notes/result.txt", "真实结果\n")).toEqual({
      path: "notes/result.txt",
      bytes: Buffer.byteLength("真实结果\n", "utf8"),
    });
    expect(readFileSync(join(root, "notes", "result.txt"), "utf8")).toBe("真实结果\n");
  });

  it("rejects unsafe or oversized write targets before changing the filesystem", () => {
    const parent = mkdtempSync(join(tmpdir(), "prometheus-workspace-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    mkdirSync(root);
    const service = new WorkspaceService(root);

    expect(() => service.writeTextFile("../outside.txt", "no"))
      .toThrow("Path escapes workspace root");
    expect(() => service.writeTextFile("missing/result.txt", "no"))
      .toThrow();
    expect(() => service.writeTextFile("large.txt", "x".repeat(1024 * 1024 + 1)))
      .toThrow("Write content exceeds 1048576 bytes");
  });

  it("overwrites regular files but rejects symbolic-link write targets", () => {
    const parent = mkdtempSync(join(tmpdir(), "prometheus-workspace-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    mkdirSync(root);
    const outside = join(parent, "outside.txt");
    writeFileSync(outside, "outside", "utf8");
    writeFileSync(join(root, "regular.txt"), "before", "utf8");
    symlinkSync(outside, join(root, "linked.txt"), "file");
    const service = new WorkspaceService(root);

    service.writeTextFile("regular.txt", "after");
    expect(readFileSync(join(root, "regular.txt"), "utf8")).toBe("after");
    expect(() => service.writeTextFile("linked.txt", "no"))
      .toThrow("Symbolic link write targets are not supported");
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });
});
