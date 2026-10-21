import { describe, expect, it } from "vitest";
import { RuleSet, builtinRules, validateRule, type Rule } from "../src/engine/rules.ts";
import { DEFAULT_ALLOWLIST } from "../src/engine/rules.ts";

const ruleset = (rules: Rule[], allowlist = DEFAULT_ALLOWLIST) => new RuleSet({ rules, allowlist });

const types = (text: string): string[] => ruleset(builtinRules()).findHits(text).map((h) => h.typePrefix);

describe("builtin rule pack", () => {
	it("catches a mysql connection string as one CONNSTR, not CONNSTR + IP", () => {
		const hits = ruleset(builtinRules()).findHits("查一下 mysql://root:Pass123@10.1.2.3:3306/app");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.typePrefix).toBe("CONNSTR");
		expect(hits[0]?.plaintext).toBe("mysql://root:Pass123@10.1.2.3:3306/app");
	});

	it("catches phone and national id", () => {
		const t = types("mobile 13800138000 id 110101199003078515");
		expect(t).toContain("PHONE");
		expect(t).toContain("IDCARD");
	});

	it("finds public and private IPs", () => {
		const hits = ruleset(builtinRules())
			.findHits("edge 8.8.8.8 and dc 10.0.0.5")
			.filter((h) => h.typePrefix === "IP")
			.map((h) => h.plaintext);
		expect(hits).toContain("8.8.8.8");
		expect(hits).toContain("10.0.0.5");
	});

	it("never rewrites loopback", () => {
		expect(types("http://127.0.0.1:18787")).not.toContain("IP");
		expect(ruleset(builtinRules()).findHits("listen on ::1").every((h) => h.plaintext !== "::1")).toBe(true);
	});

	it("catches region markers", () => {
		const t = types("tz Asia/Shanghai lang zh-CN and zh_CN plus zh-Hans");
		expect(t).toContain("TZ");
		expect(t).toContain("LOCALE");
	});

	it("leaves email alone by default", () => {
		expect(types("write to someone@example.com")).not.toContain("EMAIL");
	});

	it("does not mistake a version string for an IP", () => {
		expect(ruleset(builtinRules()).findHits("v1.2.3.4").filter((h) => h.typePrefix === "IP")).toHaveLength(0);
	});

	it("recognises api keys and bearer tokens", () => {
		const t = types("key sk-ant-abcdefghijklmnop and Authorization: Bearer abc.def.ghi");
		expect(t).toContain("APIKEY");
		expect(t).toContain("TOKEN");
	});
});

describe("priority and overlap", () => {
	it("lets the higher priority rule consume the span", () => {
		const set = ruleset([
			{ id: "conn", name: "conn", typePrefix: "CONNSTR", enabled: true, kind: "regex", pattern: String.raw`postgres://\S+`, priority: 100 },
			{ id: "ip", name: "ip", typePrefix: "IP", enabled: true, kind: "regex", pattern: String.raw`\d+\.\d+\.\d+\.\d+`, priority: 10 },
		]);
		const hits = set.findHits("postgres://u:p@10.0.0.5/db");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.typePrefix).toBe("CONNSTR");
	});

	it("skips disabled rules", () => {
		const set = ruleset([{ id: "phone", name: "phone", typePrefix: "PHONE", enabled: false, kind: "regex", pattern: String.raw`1[3-9]\d{9}`, priority: 50 }]);
		expect(set.findHits("call 13800138000")).toHaveLength(0);
	});

	it("skips allowlisted exact strings", () => {
		const set = ruleset([{ id: "ip", name: "ip", typePrefix: "IP", enabled: true, kind: "regex", pattern: String.raw`127\.0\.0\.1`, priority: 10 }]);
		expect(set.findHits("talk to 127.0.0.1 please")).toHaveLength(0);
	});

	it("matches dictionary words literally", () => {
		const set = ruleset([{ id: "words", name: "words", typePrefix: "SECRET", enabled: true, kind: "dictionary", words: ["AKIAEXAMPLE"], priority: 80 }]);
		expect(set.findHits("AKIAEXAMPLE in text")[0]?.plaintext).toBe("AKIAEXAMPLE");
	});
});

describe("validateRule", () => {
	const base: Rule = { id: "x", name: "x", typePrefix: "X", enabled: true, kind: "regex", pattern: "a", priority: 1 };

	it("rejects a lowercase type prefix", () => {
		expect(() => validateRule({ ...base, typePrefix: "lower" })).toThrow(/类型/);
	});

	it("rejects an invalid regex", () => {
		expect(() => validateRule({ ...base, pattern: "(" })).toThrow(/正则无效/);
	});

	it("accepts a valid rule", () => {
		expect(() => validateRule(base)).not.toThrow();
	});
});
