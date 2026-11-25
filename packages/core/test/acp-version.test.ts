// Version gate of ACP presets (Antigravity needs agy >= 1.5.1).
import { ACP_PRESETS } from "@prometheus/protocol";
import { describe, expect, it } from "vitest";
import { versionBelow } from "../src/agent/acp/acp-runtime.ts";

describe("versionBelow", () => {
	it("compares numeric parts", () => {
		expect(versionBelow("1.0.1", "1.5.1")).toBe(true);
		expect(versionBelow("1.4.9", "1.5.1")).toBe(true);
		expect(versionBelow("1.5.1", "1.5.1")).toBe(false);
		expect(versionBelow("1.10.0", "1.5.1")).toBe(false);
		expect(versionBelow("2", "1.5.1")).toBe(false);
	});
	it("tolerates prefixes and does not judge unparsable versions", () => {
		expect(versionBelow("v1.2.0-beta", "1.5.1")).toBe(true);
		expect(versionBelow("unknown", "1.5.1")).toBe(false);
	});
});

describe("Antigravity preset", () => {
	it("starts `agy acp` and requires 1.5.1", () => {
		const p = ACP_PRESETS.find((a) => a.id === "antigravity");
		expect(p).toMatchObject({ kind: "acp", command: "agy", args: ["acp"], minVersion: "1.5.1", updateHint: "agy update" });
	});
});

// preset gate: bust stale transform cache
