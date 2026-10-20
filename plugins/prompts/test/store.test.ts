import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStore, newProfile, profileFor, sanitizeProfile, seedProfiles, type PromptsState } from "../src/store.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "prompts-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("seedProfiles", () => {
	it("adds the shipped profiles once and is idempotent", () => {
		const once = seedProfiles({ active: null, overrides: {}, profiles: [], seeded: false });
		expect(once.seeded).toBe(true);
		expect(once.profiles.map((p) => p.id).sort()).toEqual(["operator", "research"]);
		expect(seedProfiles(once)).toBe(once);
	});

	it("keeps a user-chosen default across a reseed", () => {
		const once = seedProfiles({ active: "research", overrides: {}, profiles: [], seeded: false });
		expect(once.active).toBe("research");
	});

	it("drops a default that points at a removed profile", () => {
		const once = seedProfiles({ active: "gone", overrides: {}, profiles: [], seeded: false });
		expect(once.active).toBeNull();
	});
});

describe("profileFor", () => {
	const state: PromptsState = seedProfiles({
		active: "operator",
		overrides: { s1: "research" },
		profiles: [],
		seeded: false,
	});

	it("prefers the chat's own pick", () => {
		expect(profileFor(state, "s1")?.id).toBe("research");
		expect(profileFor(state, "s2")?.id).toBe("operator");
	});

	it("ignores an override that is switched off", () => {
		const off: PromptsState = {
			...state,
			profiles: state.profiles.map((p) => (p.id === "research" ? { ...p, enabled: false } : p)),
		};
		expect(profileFor(off, "s1")?.id).toBe("operator");
	});

	it("returns nothing when nothing is enabled", () => {
		const none: PromptsState = { ...state, active: null, overrides: {}, profiles: state.profiles.map((p) => ({ ...p, enabled: false })) };
		expect(profileFor(none, "s1")).toBeUndefined();
	});
});

describe("sanitizeProfile", () => {
	it("rejects non-objects", () => {
		expect(() => sanitizeProfile(null)).toThrow(/不合法/);
		expect(() => sanitizeProfile("nope")).toThrow(/不合法/);
	});

	it("keeps the id of the profile being edited and fills defaults", () => {
		const prior = { ...newProfile(), id: "fixed", title: "旧名字" };
		const out = sanitizeProfile({ title: "  新名字  " }, prior);
		expect(out.id).toBe("fixed");
		expect(out.title).toBe("新名字");
		expect(out.mode).toBe("replace");
	});

	it("falls back on values a client made up", () => {
		const out = sanitizeProfile({ title: "x", mode: "explode", base: "whatever", source: "remote" });
		expect(out.mode).toBe("replace");
		expect(out.base).toBe("operator");
		expect(out.source).toBe("inline");
	});

	it("caps the body and the title", () => {
		const out = sanitizeProfile({ title: "t".repeat(500), body: "b".repeat(500_000) }, newProfile());
		expect(out.title.length).toBe(120);
		expect(out.body?.length).toBe(400_000);
	});
});

describe("store", () => {
	it("round-trips through the json file with a seeded default", async () => {
		const store = makeStore(join(dir, "prompts.json"));
		await store.update((s) => seedProfiles(s));
		const back = await store.read();
		expect(back.seeded).toBe(true);
		expect(back.profiles).toHaveLength(2);
	});

	it("serialises concurrent updates instead of losing writes", async () => {
		const store = makeStore(join(dir, "prompts.json"));
		await Promise.all(
			["a", "b", "c"].map((id) =>
				store.update((s) => ({ ...s, profiles: [...s.profiles, { ...newProfile(), id, title: id }] })),
			),
		);
		const back = await store.read();
		expect(back.profiles.map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
});

describe("empty state", () => {
	it("starts with no selection so an untouched install changes nothing", () => {
		expect(seedProfiles({ active: null, overrides: {}, profiles: [], seeded: false }).active).toBeNull();
	});
});
