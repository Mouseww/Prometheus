import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceNode } from "@prometheus/protocol";

const ignoredNames = new Set([
  ".git",
  ".prometheus",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

export class WorkspaceService {
  readonly #root: string;

  constructor(root: string) {
    this.#root = realpathSync(root);
  }

  get rootName(): string {
    return basename(this.#root);
  }

  resolveDirectory(relativePath = ""): string {
    const resolved = this.#resolveExisting(relativePath);
    if (!statSync(resolved).isDirectory()) throw new Error("Path is not a directory");
    return resolved;
  }

  list(relativePath = ""): WorkspaceNode[] {
    const resolved = this.#resolveExisting(relativePath);

    return readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => !ignoredNames.has(entry.name) && !entry.isSymbolicLink())
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({
        name: entry.name,
        path: relative(this.#root, resolve(resolved, entry.name)).split(sep).join("/"),
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });
  }

  readTextFile(relativePath: string, maxBytes = 64 * 1024): { content: string; truncated: boolean } {
    const resolved = this.#resolveExisting(relativePath);
    if (!statSync(resolved).isFile()) throw new Error("Path is not a file");
    const bytes = readFileSync(resolved);
    if (bytes.subarray(0, 8_192).includes(0)) throw new BinaryFileError(relativePath);
    const truncated = bytes.length > maxBytes;
    return {
      content: bytes.subarray(0, maxBytes).toString("utf8"),
      truncated,
    };
  }

  writeTextFile(
    relativePath: string,
    content: string,
    maxBytes = 1024 * 1024,
  ): { path: string; bytes: number } {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxBytes) {
      throw new Error(`Write content exceeds ${maxBytes} bytes`);
    }
    if (isAbsolute(relativePath)) {
      throw new WorkspaceBoundaryError(relativePath);
    }

    const lexicalTarget = resolve(this.#root, relativePath);
    this.#assertContained(lexicalTarget);
    const realParent = realpathSync(dirname(lexicalTarget));
    this.#assertContained(realParent);
    const target = resolve(realParent, basename(lexicalTarget));
    this.#assertContained(target);

    if (existsSync(target)) {
      const stats = lstatSync(target);
      if (stats.isSymbolicLink()) throw new Error("Symbolic link write targets are not supported");
      if (!stats.isFile()) throw new Error("Write target is not a file");
    }

    writeFileSync(target, content, "utf8");
    return {
      path: relative(this.#root, target).split(sep).join("/"),
      bytes,
    };
  }

  searchText(query: string, relativePath = "", maxResults = 100): WorkspaceSearchMatch[] {
    const start = this.#resolveExisting(relativePath);
    const needle = query.toLocaleLowerCase();
    const matches: WorkspaceSearchMatch[] = [];

    const visit = (path: string): void => {
      if (matches.length >= maxResults) return;
      const stats = statSync(path);
      if (stats.isFile()) {
        if (stats.size > 1024 * 1024) return;
        const bytes = readFileSync(path);
        if (bytes.subarray(0, 8_192).includes(0)) return;
        const lines = bytes.toString("utf8").split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (!line.toLocaleLowerCase().includes(needle)) continue;
          matches.push({
            path: relative(this.#root, path).split(sep).join("/"),
            line: index + 1,
            text: line.slice(0, 300),
          });
          if (matches.length >= maxResults) return;
        }
        return;
      }
      if (!stats.isDirectory()) return;
      const entries = readdirSync(path, { withFileTypes: true })
        .filter((entry) => !ignoredNames.has(entry.name) && !entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        visit(resolve(path, entry.name));
        if (matches.length >= maxResults) return;
      }
    };

    visit(start);
    return matches;
  }

  #resolveExisting(relativePath: string): string {
    const resolved = realpathSync(resolve(this.#root, relativePath));
    this.#assertContained(resolved);
    return resolved;
  }

  #assertContained(path: string): void {
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new WorkspaceBoundaryError(path);
    }
  }
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export class WorkspaceBoundaryError extends Error {
  constructor(path: string) {
    super(`Path escapes workspace root: ${path}`);
  }
}

export class BinaryFileError extends Error {
  constructor(path: string) {
    super(`Binary files are not supported: ${path}`);
  }
}
