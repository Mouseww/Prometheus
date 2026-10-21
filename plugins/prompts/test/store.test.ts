import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED } from "../src/bundled.ts";
import { bodyOf, makeStore, newProfile, promptFor, sanitizeProfile, seedProfiles } from "../src/store.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "prompts-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const seeded = () => seedProfiles({ profiles: [], seeded: 0 });

describe("seedProfiles", () => {
	it("gives every permission mode exactly one prompt", () => {
		const state = seeded();
		expect(state.profiles.map((p) => p.mode).sort()).toEqual(["acceptEdits", "auto", "bypassPermissions", "default", "plan"]);
	});

	it("points each prompt at a bundled file that exists", () => {
		for (const p of seeded().profiles) {
			expect(p.file && BUNDLED[p.file]).toBeTruthy();
		}
	});

	it("is idempotent", () => {
		const once = seeded();
		expect(seedProfiles(once)).toBe(once);
	});

	it("keeps a user's edits when seeding an already-seeded state", () => {
		const once = seeded();
		const edited = { ...once, profiles: once.profiles.map((p) => (p.mode === "default" ? { ...p, body: "mine" } : p)) };
		expect(seedProfiles(edited)).toBe(edited);
	});
});

describe("promptFor", () => {
	it("picks the prompt for the requested mode", () => {
		const state = seeded();
		expect(promptFor(state, "plan")?.mode).toBe("plan");
		expect(promptFor(state, "bypassPermissions")?.file).toBe("whitehat.en.md");
	});

	it("skips disabled prompts", () => {
		const state = seeded();
		const off = { ...state, profiles: state.profiles.map((p) => (p.mode === "plan" ? { ...p, enabled: false } : p)) };
		expect(promptFor(off, "plan")).toBeUndefined();
	});

	it("prefers the seeded prompt when a mode has several", () => {
		const state = seeded();
		const extra = { ...newProfile("plan"), id: "custom-plan", title: "mine" };
		const withExtra = { ...state, profiles: [...state.profiles, extra] };
		expect(promptFor(withExtra, "plan")?.id).toBe("builtin-plan");
	});

	it("returns nothing for a mode with no prompt", () => {
		expect(promptFor({ profiles: [], seeded: 2 }, "default")).toBeUndefined();
	});
});

describe("bodyOf", () => {
	it("reads the bundled text, and a body shadows it", () => {
		const [first] = seeded().profiles;
		expect(bodyOf(first!)).toBe(BUNDLED[first!.file!]);
		expect(bodyOf({ ...first!, body: "edited" })).toBe("edited");
	});

	it("returns undefined for an unknown bundled file", () => {
		expect(bodyOf({ ...newProfile("default"), file: "nope.md", body: undefined })).toBeUndefined();
	});
});

describe("sanitizeProfile", () => {
	it("rejects non-objects", () => {
		expect(() => sanitizeProfile(null)).toThrow(/不合法/);
	});

	it("keeps the id being edited and defaults the rest", () => {
		const prior = { ...newProfile("auto"), id: "fixed", title: "old" };
		const out = sanitizeProfile({ title: "  new  " }, prior);
		expect(out.id).toBe("fixed");
		expect(out.title).toBe("new");
		expect(out.mode).toBe("auto");
	});

	it("falls back on values a client made up", () => {
		const out = sanitizeProfile({ mode: "nope", how: "explode" }, newProfile("default"));
		expect(out.mode).toBe("default");
		expect(out.how).toBe("append");
	});

	it("drops the file name once a body is present, so edits win", () => {
		const prior = { ...newProfile("plan"), file: "plan.en.md", body: undefined };
		const out = sanitizeProfile({ body: "custom text" }, prior);
		expect(out.body).toBe("custom text");
		expect(out.file).toBeUndefined();
	});

	it("caps the body and the title", () => {
		const out = sanitizeProfile({ title: "t".repeat(500), body: "b".repeat(500_000) }, newProfile("default"));
		expect(out.title.length).toBe(120);
		expect(out.body?.length).toBe(400_000);
	});
});

describe("store", () => {
	it("serialises concurrent updates instead of losing writes", async () => {
		const store = makeStore(join(dir, "prompts.json"));
		await Promise.all(
			["a", "b", "c"].map((id) => store.update((s) => ({ ...s, profiles: [...s.profiles, { ...newProfile("default"), id, title: id }] }))),
		);
		expect((await store.read()).profiles.map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
});

describe("migration", () => {
	it("replaces a pre-mode state instead of leaving every mode empty", () => {
		// The previous version wrote seeded: true and profiles with a `mode: "replace"` field.
		const legacy = {
			profiles: [{ id: "operator", mode: "replace", title: "Operator", description: "", enabled: true, how: "replace", dropPersona: false, updatedAt: 0 }],
			seeded: true,
		} as unknown as Parameters<typeof seedProfiles>[0];
		const out = seedProfiles(legacy);
		expect(out.profiles.map((p) => p.mode).sort()).toEqual(["acceptEdits", "auto", "bypassPermissions", "default", "plan"]);
	});

	it("leaves a current state untouched", () => {
		const current = seedProfiles({ profiles: [], seeded: 0 });
		expect(seedProfiles(current)).toBe(current);
	});
});
