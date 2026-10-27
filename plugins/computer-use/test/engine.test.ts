import { describe, expect, it } from "vitest";
import { diff, treeSignature } from "../src/engine/diff.ts";
import { prune } from "../src/engine/prune.ts";
import { redactText } from "../src/engine/redact.ts";
import { estimateTokens, render } from "../src/engine/render.ts";
import type { CUNode } from "../src/protocol.ts";

const notepad = (value = "hello", extra: CUNode[] = []): CUNode => ({
	ref: "e1",
	role: "window",
	name: "无标题 - 记事本",
	children: [
		{
			ref: "e2",
			role: "pane",
			children: [
				{
					ref: "e3",
					role: "menubar",
					name: "应用程序",
					children: [
						{ ref: "e4", role: "menuitem", name: "文件", states: ["collapsed"], actions: ["expand", "collapse"] },
						{ ref: "e5", role: "menuitem", name: "编辑", states: ["collapsed"], actions: ["expand", "collapse"] },
					],
				},
			],
		},
		{ ref: "e6", role: "document", name: "文本编辑器", value, states: ["editable", "focused"], actions: ["set_value", "type", "clear"] },
		{ ref: "e7", role: "scrollbar", name: "垂直", children: [{ ref: "e8", role: "thumb" }] },
		{ ref: "e9", role: "button", name: "隐藏", states: ["offscreen"] },
		{ ref: "e10", role: "statusbar", name: "状态栏", children: [{ ref: "e11", role: "text", name: "第 1 行，第 6 列" }] },
		{ ref: "e12", role: "textbox", name: "密码", value: "hunter2", states: ["password", "editable"] },
		...extra,
	],
});

describe("prune + render", () => {
	it("drops decorative/offscreen nodes, flattens unnamed panes and masks passwords", () => {
		const { tree, hidden } = prune(notepad());
		const out = render(tree, { budget: 2000, focus: "e6" }).text;
		expect(out).toContain('[e4] menuitem "文件" collapsed');
		expect(out).toContain('[e6] document "文本编辑器" = "hello" focused editable');
		expect(out).not.toContain("scrollbar");
		expect(out).not.toContain("隐藏");
		expect(out).not.toContain("[e2]"); // unnamed pane flattened
		expect(out).not.toContain("hunter2");
		expect(out).toContain('[e12] textbox "密码" = "••••"');
		expect(hidden).toBeGreaterThan(0);
		// Menubar sits directly under the window once the pane is gone.
		expect(out.split("\n").find((l) => l.includes("[e3]"))).toMatch(/^ {2}\[e3\]/);
	});

	it("keeps the focus path and interactive elements when over budget", () => {
		const many: CUNode[] = Array.from({ length: 200 }, (_, i) => ({ ref: `t${i}`, role: "text", name: `一段很长的说明文字 ${i}` }));
		const { tree } = prune(notepad("x", many));
		const r = render(tree, { budget: 150, focus: "e6" });
		expect(r.text).toContain("[e6]");
		expect(r.text).toContain("[e4]");
		expect(r.cut).toBeGreaterThan(0);
		expect(estimateTokens(r.text)).toBeLessThan(400);
	});

	it("filters by query and keeps ancestors", () => {
		const { tree } = prune(notepad());
		const out = render(tree, { budget: 2000, query: "编辑" }).text;
		expect(out).toContain("[e5]");
		expect(out).toContain("[e3]");
		expect(out).not.toContain("[e10]");
	});

	it("caps long sibling lists", () => {
		const list: CUNode = { ref: "l", role: "list", name: "文件", children: Array.from({ length: 80 }, (_, i) => ({ ref: `i${i}`, role: "listitem", name: `file${i}.txt` })) };
		const { tree } = prune({ ref: "w", role: "window", name: "w", children: [list] });
		const out = render(tree, { budget: 5000 }).text;
		expect(out).toContain("另有 30 项");
		expect(out).not.toContain("file79.txt");
	});
});

describe("diff", () => {
	it("reports value/state changes, additions and removals by ref", () => {
		const a = prune(notepad("hello")).tree;
		const menu: CUNode = { ref: "e40", role: "menu", name: "文件", children: [{ ref: "e41", role: "menuitem", name: "保存(S)" }] };
		const nextRaw = notepad("hello world", [menu]);
		nextRaw.children = nextRaw.children!.filter((c) => c.ref !== "e10");
		const b = prune(nextRaw).tree;
		const d = diff(a, b);
		expect(d.text).toContain('~ [e6] document "文本编辑器": value → "hello world"');
		expect(d.text).toContain('+ [e40] menu "文件"');
		expect(d.text).toContain('+   [e41] menuitem "保存(S)"');
		expect(d.text).toContain('- [e10] statusbar "状态栏"');
		expect(d.big).toBe(false);
		expect(treeSignature(a)).not.toBe(treeSignature(b));
		expect(treeSignature(a)).toBe(treeSignature(prune(notepad("hello")).tree));
	});

	it("is empty when nothing changed", () => {
		const d = diff(prune(notepad()).tree, prune(notepad()).tree);
		expect(d.changes).toBe(0);
		expect(d.text).toBe("");
	});
});

describe("redact", () => {
	it("masks tokens and one-time codes", () => {
		expect(redactText("key sk-abcdefghijklmnopqrstuvwx here")).toBe("key [已隐藏密钥] here");
		expect(redactText("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[已隐藏密钥]");
		expect(redactText("您的验证码是 482913，5 分钟内有效")).toBe("您的验证码是 ••••，5 分钟内有效");
		expect(redactText("订单 482913 已发货")).toBe("订单 482913 已发货");
	});
});
