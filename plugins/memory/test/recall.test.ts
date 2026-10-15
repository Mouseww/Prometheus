import type { MemoryEntry } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { cleanTags, normalizeProject, renderMemorySection, search, selectForPrompt, tokenize, visibleTo } from "../src/recall.ts";

const entry = (id: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
	id,
	content,
	tags: [],
	scope: "user",
	pinned: false,
	source: "user",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...extra,
});

describe("memory recall", () => {
	it("tokenizes latin words and CJK bigrams", () => {
		const t = tokenize("用户偏好 TypeScript");
		expect(t.has("typescript")).toBe(true);
		expect(t.has("用户")).toBe(true);
		expect(t.has("偏好")).toBe(true);
	});

	it("ranks relevant memories and drops unrelated ones", () => {
		const entries = [entry("a", "用户喜欢使用 pnpm 管理依赖"), entry("b", "部署目标是 Kubernetes"), entry("c", "回复使用简体中文")];
		const hits = search(entries, "用 pnpm 安装依赖", 5);
		expect(hits[0]?.entry.id).toBe("a");
		expect(hits.some((h) => h.entry.id === "b")).toBe(false);
	});

	it("always includes pinned memories", () => {
		const entries = [entry("p", "永远用中文回答", { pinned: true }), entry("x", "数据库是 Postgres")];
		const picked = selectForPrompt(entries, "Postgres 连接池怎么配");
		expect(picked.map((e) => e.id).sort()).toEqual(["p", "x"]);
	});

	it("scopes project memories to their directory", () => {
		const here = normalizeProject("/work/a");
		const entries = [entry("u", "global"), entry("pa", "a only", { scope: "project", project: here }), entry("pb", "b only", { scope: "project", project: normalizeProject("/work/b") })];
		expect(visibleTo(entries, "/work/a").map((e) => e.id)).toEqual(["u", "pa"]);
	});

	it("renders a delimited prompt section", () => {
		const out = renderMemorySection([entry("a", "line1\nline2")]);
		expect(out).toContain("<memory>");
		expect(out).toContain("[a] line1 line2");
	});

	it("cleans tags", () => {
		expect(cleanTags([" a ", "a", "", 3, "b"])).toEqual(["a", "b"]);
		expect(cleanTags("nope")).toEqual([]);
	});
});
