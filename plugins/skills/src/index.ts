import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import type { SkillDocument, SkillInfo } from "@prometheus/protocol";
import { checkSkillDocument, renderSkill, requireSkillName } from "./skill-file.ts";

interface State {
	disabled: string[];
}

export default definePlugin({
	name: "skills",
	version: "0.1.0",
	async setup(ctx) {
		const library = join(ctx.dataDir, "library");
		await mkdir(library, { recursive: true });
		const state = createJsonStore<State>(join(ctx.dataDir, "state.json"), () => ({ disabled: [] }));

		const ownSkills = (): Skill[] => loadSkillsFromDir({ dir: library, source: "prometheus" }).skills;
		const skillDir = (name: string) => join(library, requireSkillName(name));

		// Enabled library skills join PI's own discovery (~/.pi/agent/skills, <project>/.pi/skills).
		ctx.extension((pi) => {
			pi.on("resources_discover", async () => {
				const disabled = new Set((await state.read()).disabled);
				return { skillPaths: ownSkills().filter((s) => !disabled.has(s.name)).map((s) => s.baseDir) };
			});
		});

		ctx.rpc("list", async (): Promise<SkillInfo[]> => {
			const disabled = new Set((await state.read()).disabled);
			const toInfo = (s: Skill, scope: SkillInfo["scope"]): SkillInfo => ({
				name: s.name,
				description: s.description,
				path: s.filePath,
				scope,
				enabled: scope !== "prometheus" || !disabled.has(s.name),
				editable: scope === "prometheus",
				modelInvocation: !s.disableModelInvocation,
			});
			return [
				...ownSkills().map((s) => toInfo(s, "prometheus")),
				...loadSkillsFromDir({ dir: join(ctx.agentDir, "skills"), source: "user" }).skills.map((s) => toInfo(s, "user")),
				...loadSkillsFromDir({ dir: resolve(ctx.cwd, ".pi", "skills"), source: "project" }).skills.map((s) => toInfo(s, "project")),
			];
		});

		ctx.rpc("get", async (params): Promise<SkillDocument> => {
			const name = requireSkillName(params.name);
			return { name, content: await readFile(join(skillDir(name), "SKILL.md"), "utf8") };
		});

		ctx.rpc("create", async (params) => {
			const name = requireSkillName(params.name);
			const description = typeof params.description === "string" ? params.description.trim() : "";
			if (!description) throw new Error("请填写技能描述：模型依据它决定何时使用该技能");
			const dir = skillDir(name);
			if (existsSync(dir)) throw new Error(`技能已存在：${name}`);
			const body = typeof params.body === "string" && params.body.trim() ? params.body : `# ${name}\n\n在此描述步骤与约束。`;
			const content = renderSkill(name, description, body, params.modelInvocation !== false);
			checkSkillDocument(name, content);
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "SKILL.md"), content, "utf8");
			await ctx.reloadSessions();
			return null;
		});

		ctx.rpc("save", async (params) => {
			const name = requireSkillName(params.name);
			if (typeof params.content !== "string") throw new Error("缺少 content");
			checkSkillDocument(name, params.content);
			const file = join(skillDir(name), "SKILL.md");
			if (!existsSync(file)) throw new Error(`技能不存在：${name}`);
			await writeFile(file, params.content, "utf8");
			await ctx.reloadSessions();
			return null;
		});

		ctx.rpc("toggle", async (params) => {
			const name = requireSkillName(params.name);
			await state.update((s) => {
				const disabled = new Set(s.disabled);
				if (params.enabled === false) disabled.add(name);
				else disabled.delete(name);
				return { disabled: [...disabled] };
			});
			await ctx.reloadSessions();
			return null;
		});

		ctx.rpc("delete", async (params) => {
			const name = requireSkillName(params.name);
			await rm(skillDir(name), { recursive: true, force: true });
			await state.update((s) => ({ disabled: s.disabled.filter((n) => n !== name) }));
			await ctx.reloadSessions();
			return null;
		});
	},
});
