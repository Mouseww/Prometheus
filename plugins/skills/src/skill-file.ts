/** Agent Skills naming: lowercase letters, digits and single hyphens. */
export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
export const MAX_SKILL_BYTES = 256 * 1024;

export function requireSkillName(value: unknown): string {
	if (typeof value !== "string" || !SKILL_NAME.test(value)) {
		throw new Error("技能名只能包含小写字母、数字和单个连字符，且不超过 64 个字符");
	}
	return value;
}

/** Build a SKILL.md; JSON strings are valid YAML double-quoted scalars, so no escaping pitfalls. */
export function renderSkill(name: string, description: string, body: string, modelInvocation = true): string {
	const lines = ["---", `name: ${name}`, `description: ${JSON.stringify(description.trim())}`];
	if (!modelInvocation) lines.push("disable-model-invocation: true");
	lines.push("---", "", body.trim(), "");
	return lines.join("\n");
}

/** Validate user-edited SKILL.md: it must keep frontmatter whose name matches its directory. */
export function checkSkillDocument(name: string, content: string): void {
	if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) throw new Error("SKILL.md 过大（上限 256KB）");
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!match?.[1]) throw new Error("SKILL.md 必须以 --- 包裹的 frontmatter 开头");
	const fm = match[1];
	const nameLine = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm);
	if (nameLine && nameLine[1] !== name) throw new Error(`frontmatter 中的 name 必须是 ${name}`);
	if (!/^description:\s*\S/m.test(fm)) throw new Error("frontmatter 缺少 description");
}
