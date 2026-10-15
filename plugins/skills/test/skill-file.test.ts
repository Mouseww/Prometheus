import { describe, expect, it } from "vitest";
import { checkSkillDocument, renderSkill, requireSkillName } from "../src/skill-file.ts";

describe("skill files", () => {
	it("validates names", () => {
		expect(requireSkillName("pdf-tools")).toBe("pdf-tools");
		for (const bad of ["PDF", "a--b", "-a", "a-", "../x", "a/b", ""]) expect(() => requireSkillName(bad)).toThrow();
	});

	it("renders frontmatter that round-trips validation", () => {
		const doc = renderSkill("review", 'Review code: "carefully"\nnew line', "# Steps", false);
		expect(doc).toContain('description: "Review code: \\"carefully\\"\\nnew line"');
		expect(doc).toContain("disable-model-invocation: true");
		expect(() => checkSkillDocument("review", doc)).not.toThrow();
	});

	it("rejects documents without frontmatter or with a mismatched name", () => {
		expect(() => checkSkillDocument("a", "# no frontmatter")).toThrow();
		expect(() => checkSkillDocument("a", "---\nname: b\ndescription: x\n---\n")).toThrow();
		expect(() => checkSkillDocument("a", "---\nname: a\n---\n")).toThrow();
	});
});
