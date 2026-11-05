import { describe, expect, it } from "vitest";
import { displayPath, parseUnifiedDiff } from "../src/team/diff.ts";

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function head
 keep
-old line
+new line
+extra
 tail
\\ No newline at end of file
@@ -20,2 +21,2 @@
 x
-y
+z
`;

describe("parseUnifiedDiff", () => {
	it("parses hunks with line numbers and counts additions and deletions", () => {
		const [f] = parseUnifiedDiff(MODIFIED);
		expect(f).toMatchObject({ oldPath: "src/a.ts", newPath: "src/a.ts", status: "modified", binary: false, additions: 3, deletions: 2 });
		expect(f?.hunks).toHaveLength(2);
		const lines = f?.hunks[0]?.lines ?? [];
		expect(lines.map((l) => [l.type, l.oldNo, l.newNo, l.text])).toEqual([
			["ctx", 1, 1, "keep"],
			["del", 2, null, "old line"],
			["add", null, 2, "new line"],
			["add", null, 3, "extra"],
			["ctx", 3, 4, "tail"],
			["meta", null, null, "\\ No newline at end of file"],
		]);
		// Numbering restarts from the second hunk header.
		expect(f?.hunks[1]?.lines[0]).toMatchObject({ oldNo: 20, newNo: 21 });
		// The trailing newline of the whole text is not a phantom context line.
		expect(f?.hunks[1]?.lines.at(-1)).toMatchObject({ type: "add", text: "z" });
	});

	it("detects added, deleted and renamed files", () => {
		const text = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
`;
		const files = parseUnifiedDiff(text);
		expect(files.map((f) => f.status)).toEqual(["added", "deleted", "renamed"]);
		expect(files[0]).toMatchObject({ newPath: "new.txt", additions: 1, deletions: 0 });
		expect(files[1]).toMatchObject({ oldPath: "gone.txt", additions: 0, deletions: 1 });
		expect(displayPath(files[1] as never)).toBe("gone.txt");
		expect(files[2]).toMatchObject({ oldPath: "old name.txt", newPath: "new name.txt", hunks: [] });
	});

	it("marks binary files and keeps parsing the next file", () => {
		const text = `diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
+b
`;
		const files = parseUnifiedDiff(text);
		expect(files[0]).toMatchObject({ binary: true, hunks: [], newPath: "img.png" });
		expect(files[1]).toMatchObject({ binary: false, additions: 1, deletions: 1 });
	});

	it("treats removed lines that look like headers as content and tolerates empty or junk input", () => {
		const text = `diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,2 +1,1 @@
--- not a header
+++ also content
`;
		const [f] = parseUnifiedDiff(text);
		expect(f?.deletions).toBe(1);
		expect(f?.additions).toBe(1);
		expect(f?.newPath).toBe("a.md");
		expect(parseUnifiedDiff("")).toEqual([]);
		expect(parseUnifiedDiff("garbage\nmore garbage")).toEqual([]);
	});

	it("keeps empty context lines whose leading space was trimmed", () => {
		const text = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n one\n\n-two\n+three\n";
		const lines = parseUnifiedDiff(text)[0]?.hunks[0]?.lines ?? [];
		expect(lines.map((l) => l.type)).toEqual(["ctx", "ctx", "del", "add"]);
		expect(lines[1]).toMatchObject({ text: "", oldNo: 2, newNo: 2 });
	});
});
