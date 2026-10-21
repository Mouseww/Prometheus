import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED } from "../src/bundled.ts";
import { bodyOf, makeStore, newProfile, profileFor, sanitizeProfile, seedProfiles } from "../src/store.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "prompts-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const seed = (over: Partial<Parameters<typeof seedProfiles>[0]> = {}) => seedProfiles({ profiles: [], selected: null, overrides: {}, seeded: 0, ...over });

describe("seedProfiles", () => {
	it("ships the four prompts, none selected", () => {
		const state = seed();
		expect(state.profiles.map((p) => p.id).sort()).toEqual(["builtin-default", "builtin-operator", "builtin-research", "builtin-whitehat"]);
		// Nothing is injected until the user picks one.
		expect(state.selected).toBeNull();
	});

	it("points each prompt at a bundled file that exists", () => {
		for (const p of seed().profiles) expect(p.file && BUNDLED[p.file]).toBeTruthy();
	});

	it("is idempotent", () => {
		const once = seed();
		expect(seedProfiles(once)).toBe(once);
	});

	it("keeps a chosen default across a reseed", () => {
		expect(seed({ selected: "builtin-whitehat" }).selected).toBe("builtin-whitehat");
	});

	it("drops a default that no longer exists", () => {
		expect(seed({ selected: "gone" }).selected).toBeNull();
	});
});

describe("prompt and permission mode are independent", () => {
	it("a profile carries no permission mode at all", () => {
		for (const p of seed().profiles) expect("mode" in p).toBe(false);
	});

	it("the jailbreak prompt can be selected without touching permissions", () => {
		// Nothing in the profile state mentions bypassPermissions, so picking it changes the prompt only.
		const state = { ...seed(), selected: "builtin-whitehat" };
		expect(profileFor(state, undefined)?.file).toBe("whitehat.en.md");
		expect(JSON.stringify(state)).not.toContain("bypassPermissions");
	});
});

describe("profileFor", () => {
	const base = { ...seed(), selected: "builtin-default", overrides: { s1: "builtin-whitehat" } };

	it("prefers the chat's own pick", () => {
		expect(profileFor(base, "s1")?.id).toBe("builtin-whitehat");
		expect(profileFor(base, "s2")?.id).toBe("builtin-default");
	});

	it("falls back to the default when the override is disabled", () => {
		const off = { ...base, profiles: base.profiles.map((p) => (p.id === "builtin-whitehat" ? { ...p, enabled: false } : p)) };
		expect(profileFor(off, "s1")?.id).toBe("builtin-default");
	});

	it("injects nothing when no default is chosen", () => {
		expect(profileFor({ ...base, selected: null, overrides: {} }, "s2")).toBeUndefined();
	});
});

describe("bodyOf", () => {
	it("reads the bundled text, and a body shadows it", () => {
		const first = seed().profiles[0]!;
		expect(bodyOf(first)).toBe(BUNDLED[first.file!]);
		expect(bodyOf({ ...first, body: "edited" })).toBe("edited");
	});

	it("returns undefined for an unknown bundled file", () => {
		expect(bodyOf({ ...newProfile(), file: "nope.md", body: undefined })).toBeUndefined();
	});
});

describe("sanitizeProfile", () => {
	it("rejects non-objects", () => {
		expect(() => sanitizeProfile(null)).toThrow(/不合法/);
	});

	it("keeps the id being edited and defaults the rest", () => {
		const prior = { ...newProfile(), id: "fixed", title: "old" };
		const out = sanitizeProfile({ title: "  new  " }, prior);
		expect(out.id).toBe("fixed");
		expect(out.title).toBe("new");
	});

	it("drops the file name once a body is present, so edits win", () => {
		const prior = { ...newProfile(), file: "whitehat.en.md", body: undefined };
		const out = sanitizeProfile({ body: "custom" }, prior);
		expect(out.body).toBe("custom");
		expect(out.file).toBeUndefined();
	});

	it("caps the body and the title", () => {
		const out = sanitizeProfile({ title: "t".repeat(500), body: "b".repeat(500_000) }, newProfile());
		expect(out.title.length).toBe(120);
		expect(out.body?.length).toBe(400_000);
	});
});

describe("migration", () => {
	it("rebuilds a mode-bound state instead of leaving dead entries", () => {
		const v2 = {
			profiles: [{ id: "builtin-plan", title: "Plan", description: "", enabled: true, how: "replace", dropPersona: false, updatedAt: 0 }],
			seeded: 2,
		} as unknown as Parameters<typeof seedProfiles>[0];
		const out = seedProfiles(v2);
		expect(out.profiles.map((p) => p.id).sort()).toEqual(["builtin-default", "builtin-operator", "builtin-research", "builtin-whitehat"]);
	});

	it("leaves a current state untouched", () => {
		const current = seed();
		expect(seedProfiles(current)).toBe(current);
	});
});

describe("store", () => {
	it("serialises concurrent updates instead of losing writes", async () => {
		const store = makeStore(join(dir, "prompts.json"));
		await Promise.all(["a", "b", "c"].map((id) => store.update((s) => ({ ...s, profiles: [...s.profiles, { ...newProfile(), id, title: id }] }))));
		expect((await store.read()).profiles.map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
});
