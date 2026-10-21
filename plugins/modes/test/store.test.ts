import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED } from "../src/bundled.ts";
import { allowedTools, bodyOf, makeStore, modeFor, newMode, sanitizeMode, seedModes, type ModesState } from "../src/store.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "modes-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const seed = (over: Partial<ModesState> = {}) => seedModes({ modes: [], selected: null, overrides: {}, seeded: 0, ...over });

describe("seedModes", () => {
	it("ships four modes, none selected", () => {
		const state = seed();
		expect(state.modes.map((m) => m.id).sort()).toEqual(["builtin-default", "builtin-operator", "builtin-research", "builtin-whitehat"]);
		expect(state.selected).toBeNull();
	});

	it("points each mode at a bundled file that exists", () => {
		for (const m of seed().modes) expect(m.file && BUNDLED[m.file]).toBeTruthy();
	});

	it("is idempotent", () => {
		const once = seed();
		expect(seedModes(once)).toBe(once);
	});

	it("gives White hat every tool, Research only reads", () => {
		const modes = seed().modes;
		expect(modes.find((m) => m.id === "builtin-whitehat")?.tools).toEqual([]);
		expect(modes.find((m) => m.id === "builtin-research")?.tools).toContain("read");
		expect(modes.find((m) => m.id === "builtin-research")?.tools).not.toContain("bash");
	});
});

describe("allowedTools", () => {
	const all = ["read", "write", "bash", "grep", "web"];

	it("no mode means every tool", () => {
		expect(allowedTools(undefined, all)).toEqual(all);
	});

	it("an empty list means no restriction, not nothing", () => {
		expect(allowedTools({ ...newMode(), tools: [] }, all)).toEqual(all);
	});

	it("narrows to the listed tools", () => {
		expect(allowedTools({ ...newMode(), tools: ["read", "grep"] }, all)).toEqual(["read", "grep"]);
	});

	it("ignores names the host never offered (a mode cannot grant)", () => {
		expect(allowedTools({ ...newMode(), tools: ["read", "made_up_tool"] }, all)).toEqual(["read"]);
	});

	it("keeps the host's ordering so the catalog stays stable", () => {
		expect(allowedTools({ ...newMode(), tools: ["web", "read"] }, all)).toEqual(["read", "web"]);
	});
});

describe("modeFor", () => {
	const base = { ...seed(), selected: "builtin-default", overrides: { s1: "builtin-whitehat" } };

	it("prefers the chat's own pick", () => {
		expect(modeFor(base, "s1")?.id).toBe("builtin-whitehat");
		expect(modeFor(base, "s2")?.id).toBe("builtin-default");
	});

	it("ignores a disabled mode", () => {
		const off = { ...base, modes: base.modes.map((m) => (m.id === "builtin-whitehat" ? { ...m, enabled: false } : m)) };
		expect(modeFor(off, "s1")?.id).toBe("builtin-default");
	});

	it("applies nothing when no mode is chosen", () => {
		expect(modeFor({ ...base, selected: null, overrides: {} }, "s2")).toBeUndefined();
	});
});

describe("bodyOf", () => {
	it("reads the bundled text, and a body shadows it", () => {
		const first = seed().modes[0]!;
		expect(bodyOf(first)).toBe(BUNDLED[first.file!]);
		expect(bodyOf({ ...first, body: "edited" })).toBe("edited");
	});
});

describe("sanitizeMode", () => {
	it("rejects non-objects", () => {
		expect(() => sanitizeMode(null)).toThrow(/不合法/);
	});

	it("de-duplicates and caps the tool list", () => {
		const out = sanitizeMode({ tools: ["read", "read", "bash", "", 5] }, newMode());
		expect(out.tools).toEqual(["read", "bash"]);
	});

	it("drops the file name once a body is present", () => {
		const prior = { ...newMode(), file: "whitehat.en.md", body: undefined };
		const out = sanitizeMode({ body: "custom" }, prior);
		expect(out.body).toBe("custom");
		expect(out.file).toBeUndefined();
	});

	it("caps the body and the title", () => {
		const out = sanitizeMode({ title: "t".repeat(500), body: "b".repeat(500_000) }, newMode());
		expect(out.title.length).toBe(120);
		expect(out.body?.length).toBe(400_000);
	});
});

describe("migration", () => {
	it("rebuilds a prompt-only state into modes", () => {
		const v3 = { profiles: [{ id: "builtin-whitehat", title: "White hat", description: "", enabled: true, how: "replace", dropPersona: false, updatedAt: 0 }], seeded: 3 };
		const out = seedModes(v3 as unknown as ModesState);
		expect(out.modes.map((m) => m.id).sort()).toEqual(["builtin-default", "builtin-operator", "builtin-research", "builtin-whitehat"]);
	});

	it("leaves a current state untouched", () => {
		const current = seed();
		expect(seedModes(current)).toBe(current);
	});
});

describe("store", () => {
	it("serialises concurrent updates", async () => {
		const store = makeStore(join(dir, "modes.json"));
		await Promise.all(["a", "b", "c"].map((id) => store.update((s) => ({ ...s, modes: [...s.modes, { ...newMode(), id, title: id }] }))));
		expect((await store.read()).modes.map((m) => m.id)).toEqual(["a", "b", "c"]);
	});
});
