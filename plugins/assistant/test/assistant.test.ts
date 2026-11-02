import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { delegate, type DelegateDeps, pickProject } from "../src/delegate.ts";
import { ensureHome, listNotes, notesIndex, PERSONA, readPersona, sameDir } from "../src/home.ts";
import { mainThread } from "../src/main-thread.ts";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "assistant-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("home", () => {
	it("creates notes/ and persona.md once and never overwrites the user's edits", () => {
		const data = tmp();
		const home = ensureHome(data);
		expect(readFileSync(home.persona, "utf8")).toBe(PERSONA);
		writeFileSync(home.persona, "my rules");
		ensureHome(data);
		expect(readPersona(home)).toBe("my rules");
	});

	it("lists notes newest first and ignores folders", () => {
		const home = ensureHome(tmp());
		writeFileSync(join(home.notes, "a.md"), "1");
		writeFileSync(join(home.notes, "b.md"), "22");
		expect(listNotes(home).map((n) => n.name).sort()).toEqual(["a.md", "b.md"]);
		expect(notesIndex([])).toBe("");
		expect(notesIndex(listNotes(home))).toContain("a.md");
	});

	it("compares folders ignoring case, separators and a trailing slash", () => {
		expect(sameDir("C:\\Data\\Home\\", "c:/data/home")).toBe(process.platform === "win32" || sameDir("a/b/", "A/B"));
		expect(sameDir("", "x")).toBe(false);
	});
});

const projects = [
	{ id: "p1", path: "/p/alpha", name: "Alpha" },
	{ id: "p2", path: "/p/alpha-tools", name: "Alpha Tools" },
	{ id: "p3", path: "/p/beta", name: "Beta" },
];

describe("pickProject", () => {
	it("takes an id or exact name, and a part only when it is unambiguous", () => {
		expect(pickProject(projects, "p3")?.name).toBe("Beta");
		expect(pickProject(projects, "alpha")?.name).toBe("Alpha");
		expect(pickProject(projects, "tools")?.name).toBe("Alpha Tools");
		expect(pickProject(projects, "alp")).toBeUndefined();
		expect(pickProject(projects, "")).toBeUndefined();
	});
});

function deps(over: Partial<DelegateDeps> = {}) {
	const runs: Record<string, unknown>[] = [];
	const d: DelegateDeps = {
		homeDir: "/data/home",
		workspaces: async () => [{ id: "h", path: "/data/home", name: "home" }, ...projects],
		runAgent: async (o) => {
			runs.push({ ...o });
			return { sessionId: "child", status: "success", access: o.access, text: "done" };
		},
		...over,
	};
	return { d, runs };
}

describe("delegate", () => {
	it("runs in the project, on behalf of the calling chat, with the requested access", async () => {
		const { d, runs } = deps();
		const r = await delegate(d, { cwd: "/data/home", sessionId: "main" }, { project: "Beta", task: "look", access: "edits" });
		expect(runs[0]).toMatchObject({ cwd: "/p/beta", access: "edits", parentSessionId: "main" });
		expect(r.card).toMatchObject({ project: "Beta", status: "success", requested: "edits", access: "edits", sessionId: "child" });
	});

	it("defaults to read-only and treats anything else as read-only", async () => {
		const { d, runs } = deps();
		await delegate(d, { cwd: "/data/home", sessionId: "m" }, { project: "Beta", task: "x" });
		await delegate(d, { cwd: "/data/home", sessionId: "m" }, { project: "Beta", task: "x", access: "full" });
		expect(runs.map((r) => r.access)).toEqual(["readonly", "readonly"]);
	});

	it("tells the model when the host lowered the access", async () => {
		const { d } = deps({ runAgent: async (o) => ({ sessionId: "c", status: "success", access: "readonly", text: `ran ${o.access}` }) });
		const r = await delegate(d, { cwd: "/data/home", sessionId: "m" }, { project: "Beta", task: "x", access: "edits" });
		expect(r.text).toContain("ran read-only");
		expect(r.card).toMatchObject({ requested: "edits", access: "readonly" });
	});

	it("refuses outside the home, an empty task, home as a target and unknown projects", async () => {
		const { d, runs } = deps();
		expect((await delegate(d, { cwd: "/p/beta", sessionId: "m" }, { project: "Alpha", task: "x" })).card.status).toBe("refused");
		expect((await delegate(d, { cwd: "/data/home", sessionId: "m" }, { project: "Alpha", task: "  " })).card.status).toBe("refused");
		expect((await delegate(d, { cwd: "/data/home", sessionId: "m" }, { project: "home", task: "x" })).text).toContain("No single project");
		expect((await delegate(d, { cwd: "/data/home", sessionId: "m" }, { project: "zzz", task: "x" })).text).toContain("- Alpha");
		expect(runs).toHaveLength(0);
	});

	it("without a calling chat the host gets no parent and therefore caps at read-only", async () => {
		const { d, runs } = deps();
		await delegate(d, { cwd: "/data/home", sessionId: undefined }, { project: "Beta", task: "x", access: "edits" });
		expect(runs[0]).not.toHaveProperty("parentSessionId");
	});
});

describe("mainThread", () => {
	function fake(initial?: string, alive = true) {
		let state: { sessionId?: string } = initial ? { sessionId: initial } : {};
		let created = 0;
		const get = mainThread({
			read: async () => state,
			write: async (s) => void (state = s),
			exists: async () => alive,
			create: async () => ({ sessionId: `s${++created}` }),
		});
		return { get, created: () => created, state: () => state };
	}

	it("reuses the saved chat", async () => {
		const f = fake("old");
		expect(await f.get()).toEqual({ sessionId: "old", created: false });
		expect(f.created()).toBe(0);
	});

	it("starts one when there is none, or when the saved one is gone, and remembers it", async () => {
		const a = fake();
		expect(await a.get()).toEqual({ sessionId: "s1", created: true });
		expect(a.state()).toEqual({ sessionId: "s1" });
		const b = fake("deleted", false);
		expect((await b.get()).sessionId).toBe("s1");
	});

	it("concurrent callers share a single creation", async () => {
		const f = fake();
		const [x, y] = await Promise.all([f.get(), f.get()]);
		expect(x.sessionId).toBe(y.sessionId);
		expect(f.created()).toBe(1);
	});
});
