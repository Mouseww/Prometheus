import { Type } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@prometheus/plugin-sdk";
import type { KnowledgeService } from "./service.ts";

/** PI extension exposing knowledge bases to the agent as a `knowledge_search` tool. */
export function knowledgeExtension(service: KnowledgeService): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "knowledge_search",
			label: "知识库检索",
			description:
				"Search the user's knowledge bases for relevant passages. Use when the question may be answered by the user's own documents. Returns passages with source titles.",
			promptSnippet: "knowledge_search: semantic search over the user's knowledge bases",
			parameters: Type.Object({
				query: Type.String({ description: "Natural language search query" }),
				knowledgeBaseId: Type.Optional(Type.String({ description: "Restrict to one knowledge base id; omit to search all" })),
				topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Number of passages (default 5)" })),
			}),
			async execute(_toolCallId, params) {
				const bases = service.list().filter((b) => b.chunkCount > 0 && (!params.knowledgeBaseId || b.id === params.knowledgeBaseId));
				if (!bases.length) {
					return { content: [{ type: "text", text: "No populated knowledge base is available." }], details: { hits: [] } };
				}
				const topK = params.topK ?? 5;
				const results = await Promise.all(
					bases.map(async (b) => (await service.search(b.id, params.query, topK)).map((h) => ({ ...h, base: b.name }))),
				);
				const hits = results.flat().sort((a, b) => b.score - a.score).slice(0, topK);
				const text = hits.length
					? hits.map((h, i) => `[${i + 1}] ${h.base} / ${h.title} (score ${h.score.toFixed(3)})\n${h.text}`).join("\n\n---\n\n")
					: "No relevant passages found.";
				return { content: [{ type: "text", text }], details: { hits } };
			},
		});

		pi.on("before_agent_start", (event) => {
			const bases = service.list().filter((b) => b.chunkCount > 0);
			if (!bases.length) return;
			const list = bases.map((b) => `- ${b.id}: ${b.name}${b.description ? ` — ${b.description}` : ""}`).join("\n");
			return { systemPrompt: `${event.systemPrompt}\n\nKnowledge bases available via knowledge_search:\n${list}` };
		});
	};
}
