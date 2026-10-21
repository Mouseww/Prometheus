import { describe, expect, it } from "vitest";
import type { UIRequest } from "@prometheus/protocol";
import { applyPermissionPrompt } from "../src/permission-gate.ts";
import { autoResponse } from "../src/ui-bridge.ts";

/**
 * `sections` is an index signature, so `{}` narrows it to an empty object literal type and reading
 * any key back fails to typecheck. Typing the factory's return makes the assertions honest.
 */
function opts(): { promptGuidelines: string[]; sections: Record<string, string> } {
	return { promptGuidelines: [], sections: {} };
}

describe("applyPermissionPrompt", () => {
	it("writes auto mode into PI structured guidelines and a section, without forcing the whole prompt", () => {
		const event = { systemPromptOptions: opts() };
		applyPermissionPrompt(event, "auto");
		expect(event.systemPromptOptions.promptGuidelines.some((g) => /Auto mode/i.test(g))).toBe(true);
		expect(event.systemPromptOptions.promptGuidelines.some((g) => /pick the most sensible/i.test(g))).toBe(true);
		expect(event.systemPromptOptions.sections.auto_mode).toMatch(/every action is permitted/i);
		expect(event.systemPromptOptions.sections.plan_mode).toBeUndefined();
	});

	it("writes plan mode into guidelines so the model still sees it after other handlers run", () => {
		const event = { systemPromptOptions: opts() };
		applyPermissionPrompt(event, "plan");
		expect(event.systemPromptOptions.promptGuidelines.some((g) => /Plan mode is active/i.test(g))).toBe(true);
		expect(event.systemPromptOptions.sections.plan_mode).toMatch(/exit_plan_mode/);
	});

	it("leaves default and bypass without extra prompt sections", () => {
		for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
			const event = { systemPromptOptions: opts() };
			applyPermissionPrompt(event, mode);
			expect(event.systemPromptOptions.promptGuidelines).toEqual([]);
			expect(event.systemPromptOptions.sections).toEqual({});
		}
	});

	it("unattended overrides the live permission mode", () => {
		const event = { systemPromptOptions: opts() };
		applyPermissionPrompt(event, "auto", "readonly");
		expect(event.systemPromptOptions.sections.unattended).toMatch(/Nobody is watching/i);
		expect(event.systemPromptOptions.sections.auto_mode).toBeUndefined();
	});

	it("composes with earlier handlers instead of replacing their sections", () => {
		const event = { systemPromptOptions: { promptGuidelines: ["Keep going"], sections: { memory: "remember pnpm" } } };
		applyPermissionPrompt(event, "auto");
		expect(event.systemPromptOptions.promptGuidelines[0]).toBe("Keep going");
		expect(event.systemPromptOptions.sections.memory).toBe("remember pnpm");
		expect(event.systemPromptOptions.sections.auto_mode).toBeTruthy();
	});
});

describe("autoResponse", () => {
	// Dialogs go over the wire as UIRequest, which autoResponse is fed with; the permission prompt is
	// modeled as a union on `kind`, so one has to name its own fields rather than a bare `title`.
	// A plain Omit over a union collapses to its common keys, hence the distributive form (as in ui-bridge).
	type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
	const request = (r: DistributiveOmit<UIRequest, "id">): UIRequest => ({ id: "q1", ...r }) as UIRequest;

	it("picks the first select option and confirms yes", () => {
		expect(autoResponse(request({ method: "select", title: "Pick", options: ["A", "B"] }))).toEqual({ value: "A" });
		expect(autoResponse(request({ method: "confirm", title: "Sure?", message: "ok" }))).toEqual({ confirmed: true });
	});

	it("does not invent free text or permission answers", () => {
		expect(autoResponse(request({ method: "input", title: "Name" }))).toBeUndefined();
		expect(autoResponse(request({ method: "editor", title: "Edit" }))).toBeUndefined();
		expect(autoResponse(request({ method: "permission", kind: "tool", toolName: "bash", summary: "rm" }))).toBeUndefined();
		expect(autoResponse(request({ method: "permission", kind: "plan", plan: "do it" }))).toBeUndefined();
		expect(autoResponse(request({ method: "select", title: "Empty", options: [] }))).toBeUndefined();
	});
});
