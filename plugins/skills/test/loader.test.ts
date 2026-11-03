import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkillsFromDir, parseFrontmatter } from "../src/loader.ts";
import { renderSkill } from "../src/skill-file.ts";

describe("skill loader without the PI packages", () => {
	it("reads what renderSkill writes, including quotes and the no-model-invocation flag", () => {
		const fm = parseFrontmatter(renderSkill("demo", 'Say "hi": it\'s fine', "# body", false));
		expect(fm).toMatchObject({ name: "demo", description: 'Say "hi": it\'s fine', "disable-model-invocation": "true" });
	});
	it("handles block scalars", () => {
		expect(parseFrontmatter("---\nname: a\ndescription: >\n  one\n  two\n---\n").description).toBe("one two");
	});
	it("finds a skill folder, nested folders and root .md files, and stops at a skill root", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-"));
		const write = (rel: string, name: string) => {
			mkdirSync(join(root, rel, ".."), { recursive: true });
			writeFileSync(join(root, rel), `---\nname: ${name}\ndescription: d-${name}\n---\nbody`);
		};
		write("one/SKILL.md", "one");
		write("group/two/SKILL.md", "two");
		write("one/inner/SKILL.md", "hidden-inside-skill");
		write("loose.md", "loose");
		write("node_modules/x/SKILL.md", "ignored");
		const names = loadSkillsFromDir({ dir: root }).skills.map((s) => s.name).sort();
		expect(names).toEqual(["loose", "one", "two"]);
	});
	it("skips files without a description", () => {
		const root = mkdtempSync(join(tmpdir(), "skills-"));
		mkdirSync(join(root, "x"));
		writeFileSync(join(root, "x", "SKILL.md"), "---\nname: x\n---\n");
		expect(loadSkillsFromDir({ dir: root }).skills).toEqual([]);
	});
});
