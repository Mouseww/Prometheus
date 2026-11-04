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

describe("productivity skills", () => {
	it("ships every card with the text the home page needs", () => {
		const cards = BUILTIN_SKILLS.filter((s) => s.offered);
		expect(cards.length).toBeGreaterThanOrEqual(10);
		for (const s of cards) {
			expect(s.title, s.name).toBeTruthy();
			expect(s.tagline, s.name).toBeTruthy();
			expect(s.examples?.length, s.name).toBeGreaterThan(0);
			// A card is one click to a real request: short enough to read, specific enough to act on.
			for (const e of s.examples ?? []) expect(e.length, `${s.name}: ${e}`).toBeGreaterThan(6);
			expect(["office", "creative", "utility"]).toContain(s.category);
		}
	});

	it("uses the skill naming rules and keeps names unique", () => {
		const names = BUILTIN_SKILLS.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
		for (const s of BUILTIN_SKILLS) expect(s.name).toMatch(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/);
	});

	it("names the capability other skills depend on, so the model knows what is available", () => {
		const meta = (name: string) => BUILTIN_SKILLS.find((s) => s.name === name);
		// The report and video skills point at siblings; a rename there would break the cross-links.
		expect(meta("work-report")?.files["SKILL.md"]).toContain("office-docx");
		expect(meta("meeting-minutes")?.files["SKILL.md"]).toContain("audio-transcribe");
		expect(meta("office-docx")?.files["SKILL.md"]).toContain("office-pptx");
		expect(meta("diagram-chart")?.files["SKILL.md"]).toContain("chart");
	});
});
