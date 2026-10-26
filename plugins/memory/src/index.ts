import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createJsonStore, definePlugin } from "@prometheus/plugin-sdk";
import type { MemoryEntry, MemoryScope } from "@prometheus/protocol";
import { cleanTags, MAX_CONTENT, normalizeProject, renderMemoryIndex, renderMemorySection, search, selectForPrompt, visibleTo } from "./recall.ts";

interface State {
	entries: MemoryEntry[];
	/** Whether relevant memories are added to the system prompt each turn. */
	autoInject: boolean;
}

const MAX_ENTRIES = 5000;

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

function requireContent(value: unknown): string {
	const content = typeof value === "string" ? value.trim() : "";
	if (!content) throw new Error("记忆内容不能为空");
	if (content.length > MAX_CONTENT) throw new Error(`记忆内容不能超过 ${MAX_CONTENT} 字`);
	return content;
}

export default definePlugin({
	name: "memory",
	version: "0.1.0",
	async setup(ctx) {
		const store = createJsonStore<State>(join(ctx.dataDir, "memories.json"), () => ({ entries: [], autoInject: true }));

		const add = (input: { content: string; tags: string[]; scope: MemoryScope; cwd: string; pinned: boolean; source: MemoryEntry["source"] }) =>
			store.update((s) => {
				if (s.entries.length >= MAX_ENTRIES) throw new Error(`记忆条数已达上限 ${MAX_ENTRIES}`);
				const now = new Date().toISOString();
				const entry: MemoryEntry = {
					id: randomUUID().slice(0, 8),
					content: input.content,
					tags: input.tags,
					scope: input.scope,
					project: input.scope === "project" ? normalizeProject(input.cwd) : undefined,
					pinned: input.pinned,
					source: input.source,
					createdAt: now,
					updatedAt: now,
				};
				return { ...s, entries: [entry, ...s.entries] };
			});

		ctx.tools.register({
			name: "memory_save",
			label: "保存记忆",
			description:
				"Save a durable fact to long-term memory: user preferences, decisions, project conventions, recurring corrections. Do not store secrets or transient task details. Keep each memory to one self-contained statement.",
			promptSnippet: "memory_save: remember a durable fact across sessions",
			parameters: Type.Object({
				content: Type.String({ description: "One self-contained statement", maxLength: MAX_CONTENT }),
				scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")], { description: "user (default): applies everywhere; project: only this working directory" })),
				tags: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
			}),
			async execute(_id, params, _signal, _update, toolCtx) {
				const state = await add({
					content: requireContent(params.content),
					tags: cleanTags(params.tags),
					scope: params.scope ?? "user",
					cwd: toolCtx.cwd,
					pinned: false,
					source: "agent",
				});
				return text(`Saved memory ${state.entries[0]?.id}.`);
			},
		});

		ctx.tools.register({
			name: "memory_search",
			label: "检索记忆",
			description: "Search long-term memory for facts saved in earlier sessions.",
			promptSnippet: "memory_search: look up facts remembered from earlier sessions",
			parameters: Type.Object({
				query: Type.String(),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			}),
			async execute(_id, params, _signal, _update, toolCtx) {
				const hits = search(visibleTo((await store.read()).entries, toolCtx.cwd), params.query, params.limit ?? 8);
				return text(hits.length ? hits.map((h) => `[${h.entry.id}] ${h.entry.content}`).join("\n") : "No matching memories.");
			},
		});

		ctx.tools.register({
			name: "memory_forget",
			label: "删除记忆",
			description: "Delete a memory by id when it is wrong or the user asks to forget it.",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, params) {
				let found = false;
				await store.update((s) => {
					found = s.entries.some((e) => e.id === params.id);
					return { ...s, entries: s.entries.filter((e) => e.id !== params.id) };
				});
				return text(found ? `Forgot memory ${params.id}.` : `No memory with id ${params.id}.`);
			},
		});

		// Everything goes in `turn`: saving a memory mid-session changes both the hits and the index.
		ctx.context.provide(async (req) => {
			const state = await store.read();
			if (!state.autoInject) return undefined;
			const visible = visibleTo(state.entries, req.cwd);
			if (!visible.length) return undefined;
			const picked = selectForPrompt(visible, req.prompt);
			const parts: string[] = [];
			if (picked.length) parts.push(renderMemorySection(picked));
			parts.push(renderMemoryIndex(visible, new Set(picked.map((e) => e.id))));
			return { turn: parts.join("\n\n") };
		});

		ctx.rpc("list", async () => {
			const s = await store.read();
			return { entries: s.entries, autoInject: s.autoInject };
		});

		ctx.rpc("add", async (params) => {
			const scope: MemoryScope = params.scope === "project" ? "project" : "user";
			const cwd = typeof params.project === "string" && params.project.trim() ? params.project : ctx.cwd;
			const state = await add({ content: requireContent(params.content), tags: cleanTags(params.tags), scope, cwd, pinned: params.pinned === true, source: "user" });
			return state.entries[0];
		});

		ctx.rpc("update", async (params) => {
			const id = String(params.id ?? "");
			await store.update((s) => {
				const entry = s.entries.find((e) => e.id === id);
				if (!entry) throw new Error(`记忆不存在：${id}`);
				if (params.content !== undefined) entry.content = requireContent(params.content);
				if (params.tags !== undefined) entry.tags = cleanTags(params.tags);
				if (params.pinned !== undefined) entry.pinned = params.pinned === true;
				entry.updatedAt = new Date().toISOString();
				return s;
			});
			return null;
		});

		ctx.rpc("delete", async (params) => {
			const ids = new Set(Array.isArray(params.ids) ? params.ids.map(String) : [String(params.id ?? "")]);
			await store.update((s) => ({ ...s, entries: s.entries.filter((e) => !ids.has(e.id)) }));
			return null;
		});

		ctx.rpc("settings", async (params) => {
			await store.update((s) => ({ ...s, autoInject: params.autoInject !== false }));
			return null;
		});
	},
});
