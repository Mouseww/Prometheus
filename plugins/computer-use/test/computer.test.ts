import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AuditEntry, AuditLog } from "../src/audit.ts";
import { ComputerService, DEFAULT_SETTINGS } from "../src/computer.ts";
import { Decider } from "../src/decider.ts";
import type { CUNode, Driver, DriverHello, WindowInfo } from "../src/protocol.ts";

/** A tiny scripted "mail app": a draft box and a Send button that closes the draft. */
function fakeMail() {
	let body = "";
	let sent = false;
	let menuOpen = false;
	const calls: string[] = [];
	const windows = (): WindowInfo[] => [
		{ id: "100", pid: 7, app: "mailer", title: "新邮件", focused: true },
		...(menuOpen ? [{ id: "200", pid: 7, app: "mailer", title: "", focused: false }] : []),
	];
	const tree = (): CUNode => ({
		ref: "e1",
		role: "window",
		name: "新邮件",
		children: sent
			? [{ ref: "e9", role: "text", name: "已发送" }]
			: [
					{ ref: "e2", role: "textbox", name: "正文", value: body, states: ["editable"], actions: ["set_value"] },
					{ ref: "e3", role: "button", name: "发送", actions: ["click"] },
					{ ref: "e4", role: "button", name: "更多", actions: ["click"] },
				],
	});
	const driver: Driver = {
		hello: { platform: "windows", version: "test", capabilities: [], permissions: {} } as DriverHello,
		closed: false,
		close() {},
		async call(method: string, params: Record<string, unknown>) {
			calls.push(`${method}${params.ref ? `:${params.ref}:${params.op}` : ""}`);
			switch (method) {
				case "windows.list":
					return windows().filter((w) => w.title || params.all);
				case "tree.snapshot":
					if (params.window === "200") return { root: { ref: "m1", role: "menu", name: "更多", children: [{ ref: "m2", role: "menuitem", name: "存为草稿" }] }, truncated: false };
					return { root: tree(), truncated: false };
				case "node.act":
					if (params.ref === "e2") body = String(params.value);
					if (params.ref === "e3") sent = true;
					if (params.ref === "e4") menuOpen = true;
					return { ok: true, method: "invoke" };
				default:
					throw new Error(`unexpected ${method}`);
			}
		},
	} as Driver;
	return { driver, calls, state: () => ({ body, sent }) };
}

function setup(confirmAnswer: boolean | "no-ui", prompt = "") {
	const mail = fakeMail();
	const entries: Omit<AuditEntry, "time">[] = [];
	const audit = { write: (e: Omit<AuditEntry, "time">) => entries.push(e), flush: async () => {} } as unknown as AuditLog;
	const confirms: string[] = [];
	const ctx = {
		hasUI: confirmAnswer !== "no-ui",
		getSystemPrompt: () => prompt,
		ui: {
			confirm: async (title: string) => {
				confirms.push(title);
				return confirmAnswer === true;
			},
		},
	} as unknown as ExtensionContext;
	const svc = new ComputerService({
		driver: async () => mail.driver,
		settings: () => ({ ...DEFAULT_SETTINGS, settleMs: 5, settleTimeoutMs: 50 }),
		decider: new Decider(() => ({ kind: "off" }), () => []),
		audit,
		selfPids: new Set(),
	});
	return { svc, ctx, mail, entries, confirms };
}

describe("ComputerService", () => {
	it("observes, edits a field and reports only the change", async () => {
		const { svc, ctx, mail } = setup(true);
		const obs = await svc.observe("s", "mailer", {});
		expect(obs).toContain('[e3] button "发送"');
		const out = await svc.act("s", ctx, undefined, [{ ref: "e2", op: "set_value", value: "你好" }]);
		expect(out).toContain("✓ set_value e2");
		expect(out).toContain('~ [e2] textbox "正文": value → "你好"');
		expect(out).not.toContain("[e3]");
		expect(mail.state().body).toBe("你好");
	});

	it("asks before an irreversible click and stops when the user says no", async () => {
		const { svc, ctx, mail, entries, confirms } = setup(false);
		await svc.observe("s", "mailer", {});
		const out = await svc.act("s", ctx, undefined, [{ ref: "e3", op: "click" }]);
		expect(confirms).toEqual(["确认：发送"]);
		expect(out).toContain("已拒绝");
		expect(mail.state().sent).toBe(false);
		expect(mail.calls.some((c) => c.startsWith("node.act"))).toBe(false);
		expect(entries[0]).toMatchObject({ op: "click", ok: false, guard: "rule:发送" });
	});

	it("goes ahead once confirmed, and audits it", async () => {
		const { svc, ctx, mail, entries } = setup(true);
		await svc.observe("s", "mailer", {});
		const out = await svc.act("s", ctx, undefined, [{ ref: "e3", op: "click" }]);
		expect(mail.state().sent).toBe(true);
		expect(out).toContain('+ [e9] text "已发送"');
		expect(entries[0]).toMatchObject({ ok: true, guard: "rule:发送:confirmed", method: "invoke" });
	});

	it("refuses irreversible actions in unattended runs and does not ask", async () => {
		const { svc, ctx, mail, confirms } = setup(true, "...\n# Unattended run\nNobody is watching");
		await svc.observe("s", "mailer", {});
		const out = await svc.act("s", ctx, undefined, [{ ref: "e3", op: "click" }]);
		expect(confirms).toEqual([]);
		expect(out).toContain("无人值守");
		expect(mail.state().sent).toBe(false);
	});

	it("does not ask in auto mode", async () => {
		const { svc, ctx, mail, confirms } = setup(false, "# Auto mode\nEvery action is permitted");
		await svc.observe("s", "mailer", {});
		await svc.act("s", ctx, undefined, [{ ref: "e3", op: "click" }]);
		expect(confirms).toEqual([]);
		expect(mail.state().sent).toBe(true);
	});

	it("shows a popup menu opened by the action", async () => {
		const { svc, ctx } = setup(true);
		await svc.observe("s", "mailer", {});
		const out = await svc.act("s", ctx, undefined, [{ ref: "e4", op: "click" }]);
		expect(out).toContain("新窗口：窗口 [200]");
		expect(out).toContain('[m2] menuitem "存为草稿"');
	});

	it("refuses to work while paused", async () => {
		const { svc } = setup(true);
		svc.paused = true;
		await expect(svc.observe("s", "mailer", {})).rejects.toThrow("暂停");
	});
});
