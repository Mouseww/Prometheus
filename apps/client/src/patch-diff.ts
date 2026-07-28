export type FileDiffHunk = {
  path: string;
  original: string;
  modified: string;
  binary: boolean;
  added: number;
  removed: number;
};

/**
 * Parse a git unified / binary-aware patch into per-file left/right buffers for DiffEditor.
 * Best-effort: binary files are marked without text content.
 */
export function parseUnifiedPatch(patch: string): FileDiffHunk[] {
  const normalized = patch.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];

  const chunks = splitPatchFiles(normalized);
  const files: FileDiffHunk[] = [];

  for (const chunk of chunks) {
    const path = extractPath(chunk);
    if (!path) continue;
    if (/^GIT binary patch/m.test(chunk) || /Binary files .* differ/.test(chunk)) {
      files.push({
        path,
        original: "",
        modified: "",
        binary: true,
        added: 0,
        removed: 0,
      });
      continue;
    }

    const { original, modified, added, removed } = rebuildSides(chunk);
    files.push({ path, original, modified, binary: false, added, removed });
  }

  return files;
}

function splitPatchFiles(patch: string): string[] {
  if (patch.includes("\ndiff --git ")) {
    return patch
      .split(/\n(?=diff --git )/)
      .map((part) => part.trimEnd())
      .filter((part) => part.trim().length > 0);
  }
  // Fallback: split on --- a/ headers
  return patch
    .split(/\n(?=--- )/)
    .map((part) => part.trimEnd())
    .filter((part) => part.trim().length > 0);
}

function extractPath(chunk: string): string | null {
  const git = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git?.[2]) return git[2];
  const plus = chunk.match(/^\+\+\+ (?:b\/)?(.+)$/m);
  if (plus?.[1] && plus[1] !== "/dev/null") return plus[1];
  const minus = chunk.match(/^--- (?:a\/)?(.+)$/m);
  if (minus?.[1] && minus[1] !== "/dev/null") return minus[1];
  return null;
}

function rebuildSides(chunk: string): {
  original: string;
  modified: string;
  added: number;
  removed: number;
} {
  const lines = chunk.split("\n");
  const original: string[] = [];
  const modified: string[] = [];
  let added = 0;
  let removed = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    if (line.startsWith("+")) {
      modified.push(line.slice(1));
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      original.push(line.slice(1));
      removed += 1;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      original.push(text);
      modified.push(text);
    }
  }

  return {
    original: original.join("\n"),
    modified: modified.join("\n"),
    added,
    removed,
  };
}
