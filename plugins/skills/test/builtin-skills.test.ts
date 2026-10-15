import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { BUILTIN_SKILLS, installBuiltinSkills } from "../src/builtin-skills.ts";
import { checkSkillDocument } from "../src/skill-file.ts";

describe("built-in skills", () => {
	it("render valid SKILL.md that PI accepts without diagnostics", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prom-skills-"));
		try {
			await installBuiltinSkills(dir);
			const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "prometheus" });
			expect(diagnostics).toEqual([]);
			expect(skills.map((s) => s.name).sort()).toEqual(BUILTIN_SKILLS.map((s) => s.name).sort());
			for (const s of BUILTIN_SKILLS) {
				checkSkillDocument(s.name, readFileSync(join(dir, s.name, "SKILL.md"), "utf8"));
				expect(skills.find((x) => x.name === s.name)?.disableModelInvocation).toBeFalsy();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the always-in-context description short and the bulk in the body", () => {
		for (const s of BUILTIN_SKILLS) {
			expect(s.description.length).toBeLessThanOrEqual(1024);
			expect(s.description.length).toBeLessThan((s.files["SKILL.md"] ?? "").length / 3);
		}
	});

	it("ships the plugin guide next to SKILL.md and links to it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prom-skills-"));
		try {
			await installBuiltinSkills(dir);
			expect(readFileSync(join(dir, "prometheus", "plugin-development.md"), "utf8")).toContain("definePlugin");
			expect(readFileSync(join(dir, "prometheus", "SKILL.md"), "utf8")).toContain("plugin-development.md");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
