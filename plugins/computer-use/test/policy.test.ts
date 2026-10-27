import { describe, expect, it } from "vitest";
import { appVerdict, irreversibleByRule, isSecretWrite, keysLookIrreversible } from "../src/policy.ts";

const S = { allowApps: [], denyApps: [] };

describe("appVerdict", () => {
	it("blocks password managers, UAC, Prometheus itself and its own processes", () => {
		expect(appVerdict({ app: "KeePassXC", title: "db", pid: 1 }, S, new Set()).ok).toBe(false);
		expect(appVerdict({ app: "consent.exe", title: "用户账户控制", pid: 1 }, S, new Set()).ok).toBe(false);
		expect(appVerdict({ app: "prometheus-desktop", title: "Prometheus", pid: 1 }, S, new Set()).ok).toBe(false);
		expect(appVerdict({ app: "msedge", title: "Prometheus - Edge", pid: 1 }, S, new Set()).ok).toBe(false);
		expect(appVerdict({ app: "chrome", title: "设计讨论 · Prometheus - Google Chrome", pid: 1 }, S, new Set()).ok).toBe(false);
		expect(appVerdict({ app: "notepad", title: "x", pid: 42 }, S, new Set([42])).ok).toBe(false);
		expect(appVerdict({ app: "notepad", title: "无标题 - 记事本", pid: 1 }, S, new Set()).ok).toBe(true);
		expect(appVerdict({ app: "msedge", title: "Prometheus 文档 - 搜索", pid: 1 }, S, new Set()).ok).toBe(true);
	});

	it("honours allow and deny lists", () => {
		expect(appVerdict({ app: "notepad", title: "x", pid: 1 }, { allowApps: ["calc"], denyApps: [] }, new Set()).ok).toBe(false);
		expect(appVerdict({ app: "calc", title: "x", pid: 1 }, { allowApps: ["calc.exe"], denyApps: [] }, new Set()).ok).toBe(true);
		expect(appVerdict({ app: "wechat", title: "x", pid: 1 }, { allowApps: [], denyApps: ["WeChat"] }, new Set()).ok).toBe(false);
	});
});

describe("irreversible actions", () => {
	const btn = (name: string) => ({ role: "button", name, states: [] });
	it("flags send/pay/delete in Chinese and English", () => {
		expect(irreversibleByRule(btn("发送(S)"), "click")).toBe("发送");
		expect(irreversibleByRule(btn("立即支付"), "click")).toBe("支付");
		expect(irreversibleByRule(btn("Delete"), "click")).toBe("Delete");
		expect(irreversibleByRule(btn("Place order"), "click")).toBe("Place order");
	});
	it("ignores harmless labels, non-click ops and non-buttons", () => {
		expect(irreversibleByRule(btn("取消发送"), "click")).toBeUndefined();
		expect(irreversibleByRule(btn("删除线"), "click")).toBeUndefined();
		expect(irreversibleByRule(btn("Save draft"), "click")).toBeUndefined();
		expect(irreversibleByRule(btn("打开"), "click")).toBeUndefined();
		expect(irreversibleByRule(btn("发送"), "focus")).toBeUndefined();
		expect(irreversibleByRule({ role: "textbox", name: "发送内容", states: [] }, "click")).toBeUndefined();
	});
	it("treats Enter in chat apps and Ctrl+Enter anywhere as sending", () => {
		const edit = { role: "textbox", states: ["editable"] };
		expect(keysLookIrreversible("enter", "WeChat", edit)).toBeTruthy();
		expect(keysLookIrreversible("ctrl+enter", "notepad", edit)).toBe("Ctrl+Enter");
		expect(keysLookIrreversible("enter", "notepad", edit)).toBeUndefined();
		expect(keysLookIrreversible("ctrl+s", "WeChat", edit)).toBeUndefined();
	});
	it("confirms writes into password fields", () => {
		expect(isSecretWrite({ role: "textbox", states: ["password", "editable"] }, "set_value")).toBe(true);
		expect(isSecretWrite({ role: "textbox", states: ["editable"] }, "set_value")).toBe(false);
	});
});
