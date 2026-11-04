// What the assistant can actually do for the user, and the instruction to say so.

/** Shown on the personal home page as cards; keep in step with the skills plugin's own catalog. */
export interface Capability {
	name: string;
	title: string;
	tagline: string;
	examples: string[];
}

/**
 * The capabilities a new user would never guess the assistant has. The bodies stay in the skills plugin; this is only
 * the index the assistant is told about, so it knows to bring one up rather than answer "I can't".
 */
export function capabilityPrompt(cards: readonly Capability[]): string {
	if (!cards.length) return "";
	const lines = cards.map((c) => `- ${c.name}（${c.title}）：${c.tagline}`);
	return `## 你能替用户做的事

下面这些是这身「工作服」自带的技能，用户说「做个 PPT」「写份周报」时直接动手，不要说做不到。用到哪个先读它的 SKILL.md，按里面的步骤做。

${lines.join("\n")}

- 用户说不清楚要什么时，先把要做的活报一遍（给谁看、多长、什么时候要），用两三个方案让他挑，别硬猜。
- 一遍讲清「我可以帮你做 X」，不如直接做一半给他看。开场自我介绍只说一次，不要每轮都罗列菜单。`;
}
