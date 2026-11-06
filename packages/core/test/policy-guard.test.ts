import { describe, expect, it } from "vitest";
import { unenforceableLock } from "../src/policy-guard.ts";

describe("unenforceableLock: CLI subagents that cannot honor the administrator policy are refused", () => {
	it("lets both runners run when there is no lock", () => {
		expect(unenforceableLock("claude-code", undefined)).toBeUndefined();
		expect(unenforceableLock("codex", undefined)).toBeUndefined();
		expect(unenforceableLock("codex", { readOutsideProject: "allow", disabledTools: [] })).toBeUndefined();
	});

	it("Claude Code takes disabled tools through its own flag, so they do not refuse it", () => {
		expect(unenforceableLock("claude-code", { disabledTools: ["bash"] })).toBeUndefined();
	});

	it("Codex cannot drop tools, so any disabled tool refuses it", () => {
		expect(unenforceableLock("codex", { disabledTools: ["bash"] })).toBe("disabledTools");
	});

	it("neither runner can stay inside the project folder, so a read lock refuses both", () => {
		for (const readOutsideProject of ["ask", "deny"] as const) {
			expect(unenforceableLock("claude-code", { readOutsideProject })).toBe("readOutsideProject");
			expect(unenforceableLock("codex", { readOutsideProject })).toBe("readOutsideProject");
		}
	});
});
