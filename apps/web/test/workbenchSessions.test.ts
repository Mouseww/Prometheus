import { describe, expect, it, vi } from "vitest";

const noop = () => undefined;
vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }), addEventListener: noop, removeEventListener: noop, innerWidth: 1200 });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: noop, removeItem: noop });
vi.stubGlobal("document", {
	documentElement: { classList: { add: noop, remove: noop, toggle: noop }, style: { setProperty: noop }, dataset: {} },
	querySelector: () => ({ setAttribute: noop }),
	createElement: () => ({ setAttribute: noop }),
	head: { append: noop },
	addEventListener: noop,
	removeEventListener: noop,
	visibilityState: "visible",
});
const store = await import("../src/lib/store.ts");
const { useStore } = store;

const session = (id: string) => ({ id, messages: [], tools: {} }) as never;

describe("side panel follows the conversation", () => {
	it("keeps tabs per conversation and folds without closing", () => {
		useStore.setState({ session: session("a"), opening: null });
		store.openFile("x.ts", "/p", 1);
		expect(useStore.getState().workbench.tabs).toHaveLength(1);

		useStore.setState({ session: session("b") });
		expect(useStore.getState().workbench.tabs).toHaveLength(0);
		store.openFolderTab("/q");
		store.openTerminalTab("/q");
		expect(useStore.getState().workbench.tabs.map((t) => t.kind)).toEqual(["folder", "terminal"]);

		// Another conversation on its way: nothing is swapped yet.
		useStore.setState({ session: null, opening: { id: "a" } });
		expect(useStore.getState().workbench.tabs).toHaveLength(2);

		useStore.setState({ session: session("a"), opening: null });
		expect(useStore.getState().workbench.tabs.map((t) => t.kind)).toEqual(["file"]);
		useStore.setState({ session: session("b") });
		expect(useStore.getState().workbench.tabs.map((t) => t.kind)).toEqual(["folder", "terminal"]);

		// The title-bar button folds the panel (tabs stay), a second press shows it again.
		expect(useStore.getState().workbench.active).toMatch(/^terminal:/);
		store.toggleWorkbenchKind("terminal", "/q");
		expect(useStore.getState().workbench.collapsed).toBe(true);
		expect(useStore.getState().workbench.tabs).toHaveLength(2);
		store.toggleWorkbenchKind("folder", "/q");
		expect(useStore.getState().workbench).toMatchObject({ collapsed: false, active: "folder" });
	});

	it("a new chat's panel goes with it once it gets a session", () => {
		useStore.setState({ session: null, opening: null });
		store.openFolderTab("/n");
		useStore.setState({ session: session("c") });
		expect(useStore.getState().workbench.tabs.map((t) => t.kind)).toEqual(["folder"]);
	});
});
