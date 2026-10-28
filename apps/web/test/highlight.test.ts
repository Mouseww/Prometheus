import { describe, expect, it } from "vitest";
import { highlightLines, languageFor, splitHighlighted } from "../src/lib/highlight.ts";

describe("file viewer highlighting", () => {
	it("picks the language from the file name, then the server's guess", () => {
		expect(languageFor("src/App.tsx")).toBe("typescript");
		expect(languageFor("C:\\x\\main.RS")).toBe("rust");
		expect(languageFor("index.html")).toBe("xml");
		expect(languageFor("Cargo.toml")).toBe("ini");
		expect(languageFor("Makefile")).toBe("makefile");
		expect(languageFor("weird.ext", "python")).toBe("python");
		expect(languageFor("notes.txt", "text")).toBeNull();
		expect(languageFor("README")).toBeNull();
	});

	it("keeps one entry per line, with spans that cross lines closed and reopened", () => {
		expect(splitHighlighted('<span class="a">x\ny</span>z')).toEqual(['<span class="a">x</span>', '<span class="a">y</span>z']);
		const text = "/* one\n   two */\nconst a = `x\ny`;\n";
		const lines = highlightLines(text, "javascript")!;
		expect(lines).toHaveLength(text.split("\n").length);
		for (const l of lines) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
		expect(lines[1]).toContain("hljs-comment");
	});

	it("escapes the source and leaves big or unknown files plain", () => {
		expect(highlightLines("<script>", "xml")!.join("")).not.toContain("<script>");
		expect(highlightLines("x", null)).toBeNull();
		expect(highlightLines("a".repeat(400_000), "javascript")).toBeNull();
	});
});
