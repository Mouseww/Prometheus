// PI-free helper: the host indexes sessions with it even when the PI agent is not installed.
interface Block {
	type: string;
	text?: string;
}

export function firstUserText(messages: readonly { role: string }[]): string {
	const m = messages.find((x) => x.role === "user") as unknown as { content?: string | Block[] } | undefined;
	if (!m) return "";
	return typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}
