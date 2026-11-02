import { describe, expect, it } from "vitest";
import { accessOfMode, ceilingFor, clampAccess } from "../src/access.ts";

describe("clampAccess", () => {
	it("never goes above the ceiling", () => {
		expect(clampAccess("full", "readonly")).toBe("readonly");
		expect(clampAccess("edits", "readonly")).toBe("readonly");
		expect(clampAccess("full", "edits")).toBe("edits");
	});
	it("keeps a lower request", () => {
		expect(clampAccess("readonly", "full")).toBe("readonly");
		expect(clampAccess("edits", "edits")).toBe("edits");
	});
});

describe("accessOfMode", () => {
	it("maps modes to what may be handed on", () => {
		expect(accessOfMode("plan")).toBe("readonly");
		expect(accessOfMode("default")).toBe("readonly");
		expect(accessOfMode("acceptEdits")).toBe("edits");
		expect(accessOfMode("bypassPermissions")).toBe("full");
		expect(accessOfMode("auto")).toBe("full");
	});
});

describe("ceilingFor", () => {
	it("an unknown parent can only read", () => {
		expect(ceilingFor(undefined)).toBe("readonly");
	});
	it("an unattended parent is capped at its own access, whatever its mode says", () => {
		expect(ceilingFor({ unattended: "readonly", mode: "bypassPermissions" })).toBe("readonly");
		expect(ceilingFor({ unattended: "edits", mode: "default" })).toBe("edits");
	});
	it("an attended parent follows its mode", () => {
		expect(ceilingFor({ mode: "acceptEdits" })).toBe("edits");
	});
});
