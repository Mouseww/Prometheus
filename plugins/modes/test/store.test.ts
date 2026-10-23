import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLED } from "../src/bundled.ts";
import { allowedTools, bodyOf, composeSystemPrompt, makeStore, modeFor, newMode, planTools, sanitizeMode, seedModes, stripHostPersona, type AgentMode, type ModesState } from "../src/store.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "modes-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const seed = (over: Partial<ModesState> = {}) => seedModes({ modes: [], selected: null, overrides: {}, seeded: 0, ...over });

describe("seedModes", () => {
	it("ships six modes, none selected", () => {
		const state = seed();
		expect(state.modes.map((m) => m.id).sort()).toEqual([
			"builtin-default",
			"builtin-delegate",
			"builtin-operator",
			"builtin-purge",
			"builtin-research",
			"builtin-whitehat",
		]);
		expect(state.selected).toBeNull();
	});

	it("starts a fresh chat on the host prompt unless the default was switched on", () => {
		const state = { ...seed(), selected: "builtin-whitehat" };
		expect(modeFor(state, "new")).toBeUndefined();
		expect(modeFor({ ...state, defaultEnabled: true }, "new")?.id).toBe("builtin-whitehat");
		// A chat's own pick never depends on that switch.
		expect(modeFor({ ...state, overrides: { a: "builtin-purge" } }, "a")?.id).toBe("builtin-purge");
	});

	it("gives Purge the strictest composition and every tool", () => {
		const purge = seed().modes.find((m) => m.id === "builtin-purge")!;
		expect(purge.compose).toBe("strict");
		expect(purge.tools).toEqual([]);
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
	const base = { ...seed(), selected: "builtin-default", defaultEnabled: true, overrides: { s1: "builtin-whitehat" } };

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

	it("honours the legacy `how` field when no compose mode is sent", () => {
		expect(sanitizeMode({ how: "append" }, newMode()).compose).toBe("append");
		expect(sanitizeMode({ how: "replace" }, newMode()).compose).toBe("replace");
	});

	it("keeps a valid compose mode", () => {
		expect(sanitizeMode({ compose: "strict" }, newMode()).compose).toBe("strict");
		expect(sanitizeMode({ compose: "nonsense" }, { ...newMode(), compose: "strict" }).compose).toBe("strict");
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
		const v3 = {
			profiles: [{ id: "builtin-whitehat", title: "White hat", description: "", enabled: true, how: "replace", dropPersona: false, updatedAt: 0 }],
			seeded: 3,
			// Generation 4+ carried a mode that generation 5 replaced.
			modes: [{ ...newMode(), id: "builtin-operator", title: "Operator", file: "operator.en.md", how: "replace", dropPersona: true }],
		};
		const out = seedModes(v3 as unknown as ModesState);
		expect(out.modes.map((m) => m.id).sort()).toEqual([
			"builtin-default",
			"builtin-delegate",
			"builtin-operator",
			"builtin-purge",
			"builtin-research",
			"builtin-whitehat",
		]);
	});

	it("replaces the generation-4 shape and keeps user-written modes", () => {
		const v4 = {
			modes: [
				{ ...newMode(), id: "builtin-operator", title: "Operator", file: "operator.en.md", how: "replace", dropPersona: true },
				{ ...newMode(), id: "mine", title: "Mine", body: "keep me" },
			],
			selected: "builtin-operator",
			overrides: { a: "builtin-operator", b: "mine" },
			seeded: 4,
		};
		const out = seedModes(v4 as unknown as ModesState);
		expect(out.modes.find((m) => m.id === "mine")?.body).toBe("keep me");
		expect(out.modes.find((m) => m.id === "builtin-operator")?.compose).toBe("replace");
		// The rebuilds a mode the user had chosen only if that mode survived with its own text.
		expect(out.overrides).toEqual({ a: "builtin-operator", b: "mine" });
		expect(out.selected).toBe("builtin-operator");
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

describe("knownTools", () => {
	// Importing the tool factory pulls in the whole PI catalog, which takes seconds on a cold cache.
	it("lists the tools PI and the plugins actually provide", { timeout: 30_000 }, async () => {
		const { knownTools } = await import("../src/tools.ts");
		const names = knownTools();
		// Present on every platform, so a broken factory import cannot pass silently.
		for (const name of ["read", "write", "edit", "bash", "grep", "todo_write"]) expect(names).toContain(name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("every tool a shipped mode names really exists", async () => {
		const { knownTools } = await import("../src/tools.ts");
		const names = new Set(knownTools());
		for (const mode of seed().modes) {
			for (const tool of mode.tools) expect(names.has(tool), `${mode.id} names unknown tool ${tool}`).toBe(true);
		}
	});
});
describe("composeSystemPrompt", () => {
	const NL = String.fromCharCode(10);
	const HOST = [
		"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.",
		"",
		"<tools>",
		"- read: read a file",
		"</tools>",
		"",
		"<docs>",
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions):",
		"- Main documentation: /pi/README.md",
		"- Always read pi .md files completely (e.g., tui.md for TUI API details)",
		"</docs>",
	].join(NL);
	const mode = (compose: "append" | "replace" | "strict") => ({ ...newMode(), compose });

	it("append keeps the host prompt intact and puts the text first", () => {
		const { text } = composeSystemPrompt(mode("append"), "PERSONA", HOST, "E:/w");
		expect(text.startsWith("PERSONA" + NL + NL)).toBe(true);
		expect(text).toContain("expert coding assistant");
		expect(text).toContain("Pi documentation");
	});

	it("replace cuts the identity line and the docs section but keeps the rest", () => {
		const { text, cut } = composeSystemPrompt(mode("replace"), "PERSONA", HOST, "E:/w");
		expect(cut.identity).toBe(true);
		expect(cut.docs).toBe(true);
		expect(text).not.toContain("expert coding assistant");
		expect(text).not.toContain("Pi documentation");
		expect(text).toContain("<tools>");
	});

	it("strict sends only the persona and the working directory", () => {
		const { text } = composeSystemPrompt(mode("strict"), "PERSONA", HOST, "E:" + String.fromCharCode(92) + "w");
		expect(text).toBe("PERSONA" + NL + NL + "Current working directory: E:/w");
	});

	it("leaves an unrecognised prompt alone rather than cutting the wrong text", () => {
		const other = "some other harness prompt";
		const cut = stripHostPersona(other);
		expect(cut.text).toBe(other);
		expect(cut.identity).toBe(false);
		expect(cut.docs).toBe(false);
	});

	it("a mode with no body composes nothing", () => {
		expect(composeSystemPrompt(undefined, "", HOST, "E:/w").text).toBe(HOST);
	});
});

describe("planTools", () => {
	const open = { tools: [] } as unknown as AgentMode;
	const narrow = { tools: ["read", "grep"] } as unknown as AgentMode;

	it("never touches the tools while the mode restricts nothing", () => {
		expect(planTools(open, null, ["read", "bash"])).toEqual({ set: null, before: null });
		expect(planTools(undefined, null, ["read", "bash"])).toEqual({ set: null, before: null });
	});

	it("keeps a tool another extension activated mid-chat", () => {
		// The baseline predates `subagent`; an unrestricted mode must not switch it back off.
		const step = planTools(open, null, ["read", "bash", "subagent"]);
		expect(step.set).toBeNull();
	});

	it("narrows to the mode's tools and remembers what was active", () => {
		const step = planTools(narrow, null, ["read", "bash", "grep"]);
		expect(step).toEqual({ set: ["read", "grep"], before: ["read", "bash", "grep"] });
		// Next turn nothing changes: no re-declaration.
		expect(planTools(narrow, step.before, ["read", "grep"]).set).toBeNull();
	});

	it("leaving a restricting mode restores the removed tools and keeps later additions", () => {
		const step = planTools(open, ["read", "bash", "grep"], ["read", "grep", "subagent"]);
		expect(step.before).toBeNull();
		expect(new Set(step.set)).toEqual(new Set(["read", "grep", "subagent", "bash"]));
	});
});
