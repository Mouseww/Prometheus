// Parser for the unified diff text of `git diff` (what GET /api/merge-requests/:id/diff returns).

export type DiffLineType = "ctx" | "add" | "del" | "meta";

export interface DiffLine {
	type: DiffLineType;
	text: string;
	oldNo: number | null;
	newNo: number | null;
}

export interface DiffHunk {
	header: string;
	lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
	oldPath: string;
	newPath: string;
	status: DiffFileStatus;
	binary: boolean;
	additions: number;
	deletions: number;
	hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const stripPrefix = (p: string, prefix: "a/" | "b/"): string => {
	const unquoted = p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
	return unquoted.startsWith(prefix) ? unquoted.slice(2) : unquoted;
};

function pathsFromHeader(line: string): { oldPath: string; newPath: string } {
	const rest = line.slice("diff --git ".length);
	const m = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(rest);
	if (m) return { oldPath: m[1] as string, newPath: m[2] as string };
	return { oldPath: rest, newPath: rest };
}

/** Splits a unified diff into files and hunks. Never throws: unknown lines are ignored. */
export function parseUnifiedDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | undefined;
	let hunk: DiffHunk | undefined;
	let oldNo = 0;
	let newNo = 0;

	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const { oldPath, newPath } = pathsFromHeader(line);
			file = { oldPath, newPath, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
			files.push(file);
			hunk = undefined;
			continue;
		}
		if (!file) continue;

		if (!hunk) {
			if (line.startsWith("new file mode")) file.status = "added";
			else if (line.startsWith("deleted file mode")) file.status = "deleted";
			else if (line.startsWith("rename from ")) {
				file.status = "renamed";
				file.oldPath = line.slice("rename from ".length);
			} else if (line.startsWith("rename to ")) file.newPath = line.slice("rename to ".length);
			else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
			else if (line.startsWith("--- ")) {
				const p = line.slice(4);
				if (p !== "/dev/null") file.oldPath = stripPrefix(p, "a/");
			} else if (line.startsWith("+++ ")) {
				const p = line.slice(4);
				if (p !== "/dev/null") file.newPath = stripPrefix(p, "b/");
			}
		}

		const h = HUNK.exec(line);
		if (h) {
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			oldNo = Number(h[1]);
			newNo = Number(h[2]);
			continue;
		}
		if (!hunk) continue;

		const c = line[0];
		if (c === "+") {
			hunk.lines.push({ type: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
			file.additions += 1;
		} else if (c === "-") {
			hunk.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
			file.deletions += 1;
		} else if (c === "\\") {
			hunk.lines.push({ type: "meta", text: line, oldNo: null, newNo: null });
		} else if (c === " " || line === "") {
			// A bare empty line is an empty context line whose leading space was trimmed. The final split artifact has none.
			hunk.lines.push({ type: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
		}
	}

	// The text ends with "\n": the last split element is "" and was counted as a context line of the last hunk.
	if (text.endsWith("\n")) {
		const last = files[files.length - 1]?.hunks.at(-1);
		const tail = last?.lines.at(-1);
		if (last && tail && tail.type === "ctx" && tail.text === "") last.lines.pop();
	}
	return files;
}

/** The path to show for a file: the new path, or the old one for deletions. */
export const displayPath = (f: Pick<DiffFile, "oldPath" | "newPath" | "status">): string => (f.status === "deleted" ? f.oldPath : f.newPath);
