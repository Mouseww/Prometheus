import { describe, expect, it } from "vitest";
import { PACKAGE_KEYWORD, parseSearch, resolveRegistry, searchUrl } from "../src/registry.ts";
import { normalizeSource, npmNameOf } from "../src/source.ts";

describe("normalizeSource", () => {
	it("accepts bare npm names and prefixes them", () => {
		expect(normalizeSource("pi-subagents")).toBe("npm:pi-subagents");
		expect(normalizeSource("@scope/pkg@1.2.3")).toBe("npm:@scope/pkg@1.2.3");
		expect(normalizeSource("npm:pkg@^1.0.0")).toBe("npm:pkg@^1.0.0");
	});

	it("accepts git sources", () => {
		expect(normalizeSource("git:github.com/owner/repo@v1")).toBe("git:github.com/owner/repo@v1");
		expect(normalizeSource("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
	});

	it("rejects local paths, options and shell metacharacters", () => {
		for (const bad of ["", "./local", "../x", "/abs/path", "C:\\x", "--global", "-g", "pkg; rm -rf /", "npm:pkg && x", "git:github.com/o/r/../x", "file:///x", "http://github.com/o/r"]) {
			expect(() => normalizeSource(bad), bad).toThrow();
		}
	});
});

describe("npmNameOf", () => {
	it("strips the version", () => {
		expect(npmNameOf("npm:pkg@1.0.0")).toBe("pkg");
		expect(npmNameOf("npm:@scope/pkg@1.0.0")).toBe("@scope/pkg");
		expect(npmNameOf("npm:@scope/pkg")).toBe("@scope/pkg");
		expect(npmNameOf("git:github.com/o/r")).toBeUndefined();
	});
});

describe("registry", () => {
	it("builds a keyword-scoped search URL with paging", () => {
		const url = new URL(searchUrl("https://registry.npmjs.org", "mcp", 2, 24));
		expect(url.searchParams.get("text")).toBe(`keywords:${PACKAGE_KEYWORD} mcp`);
		expect(url.searchParams.get("from")).toBe("48");
		expect(url.searchParams.get("size")).toBe("24");
	});

	it("validates a custom registry", () => {
		expect(resolveRegistry(undefined)).toBe("https://registry.npmjs.org");
		expect(resolveRegistry("https://mirror.example.com/")).toBe("https://mirror.example.com");
		expect(() => resolveRegistry("ftp://x")).toThrow();
		expect(() => resolveRegistry("not a url")).toThrow();
	});

	it("keeps only well-formed pi-package results", () => {
		const page = parseSearch(
			{
				total: 3,
				objects: [
					{ package: { name: "good", version: "1.0.0", description: "d", keywords: ["pi-package", "mcp"], publisher: { username: "me" }, links: { npm: "https://npm/x" } } },
					{ package: { name: "no-keyword", version: "1.0.0", keywords: ["other"] } },
					{ package: { version: "1.0.0", keywords: ["pi-package"] } },
					null,
				],
			},
			0,
			24,
		);
		expect(page.total).toBe(3);
		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ name: "good", source: "npm:good", author: "me", keywords: ["mcp"] });
	});

	it("survives garbage", () => {
		expect(parseSearch(null, 0, 24).items).toEqual([]);
		expect(parseSearch({ objects: "x" }, 0, 24).items).toEqual([]);
	});
});
