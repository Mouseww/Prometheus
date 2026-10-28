// Downloading a file from the open conversation, piece by piece, to disk or to a browser download.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", globalThis);
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
vi.stubGlobal("requestAnimationFrame", (fn: () => void) => setTimeout(fn, 0));
vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
const anchors: { href: string; download: string; clicked: boolean }[] = [];
vi.stubGlobal("document", {
	documentElement: { classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined }, style: { setProperty: () => undefined }, dataset: {} },
	addEventListener: () => undefined,
	visibilityState: "visible",
	body: { appendChild: () => undefined },
	createElement: () => {
		const a = { href: "", download: "", clicked: false, click() { this.clicked = true; }, remove: () => undefined };
		anchors.push(a);
		return a;
	},
});
const blobs: Blob[] = [];
URL.createObjectURL = (b: Blob | MediaSource) => (blobs.push(b as Blob), "blob:x");
URL.revokeObjectURL = () => undefined;

// The store reads browser globals while loading, so these are imported after they exist.
const { useStore } = await import("../src/lib/store.ts");
const { baseName, downloadFile, fileExists, looksLikeFilePath, MEMORY_LIMIT } = await import("../src/lib/download.ts");

const bytes = Uint8Array.from({ length: 10_000 }, (_, i) => i % 251);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

function serve(size = bytes.length, exists = true) {
	const reads: { offset: number; length: number }[] = [];
	const client = {
		subscribe: () => undefined,
		unsubscribe: () => undefined,
		rpc: async (method: string, p: { offset: number; length: number }) => {
			if (method === "file.stat") return exists ? { exists: true, name: "报告.xlsx", size } : { exists: false };
			if (method === "file.read") {
				reads.push({ offset: p.offset, length: p.length });
				const part = bytes.subarray(p.offset, p.offset + 3000);
				return { data: b64(part), size, eof: p.offset + part.length >= bytes.length };
			}
			return null;
		},
	};
	useStore.setState({ client: client as never, session: { id: "s1" } as never });
	return reads;
}

beforeEach(() => {
	anchors.length = 0;
	blobs.length = 0;
	delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe("downloadFile", () => {
	it("without a save dialog, collects the pieces and hands the browser a file with the right name and bytes", async () => {
		const reads = serve();
		expect(await downloadFile("out/报告.xlsx")).toBe(true);
		expect(reads.map((r) => r.offset)).toEqual([0, 3000, 6000, 9000]);
		expect(anchors[0]).toMatchObject({ download: "报告.xlsx", clicked: true });
		expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(bytes);
	});

	it("with a save dialog, writes straight to the chosen file and closes it", async () => {
		serve();
		const written: Uint8Array[] = [];
		let closed = false;
		(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = async (o: { suggestedName?: string }) => {
			expect(o.suggestedName).toBe("out.xlsx");
			return { createWritable: async () => ({ write: async (d: Uint8Array) => void written.push(d), close: async () => void (closed = true), abort: async () => undefined }) };
		};
		expect(await downloadFile("out/data/out.xlsx")).toBe(true);
		expect(closed).toBe(true);
		expect(anchors).toHaveLength(0);
		const all = new Uint8Array(written.reduce((n, w) => n + w.length, 0));
		let at = 0;
		for (const w of written) (all.set(w, at), (at += w.length));
		expect(all).toEqual(bytes);
	});

	it("does nothing when the user closes the save dialog", async () => {
		const reads = serve();
		(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = async () => {
			throw new DOMException("closed", "AbortError");
		};
		expect(await downloadFile("a.xlsx")).toBe(false);
		expect(reads).toHaveLength(0);
	});

	it("gives up cleanly when the file is not there, and abandons the half-made file", async () => {
		serve(0, false);
		let aborted = false;
		(globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => undefined, close: async () => undefined, abort: async () => void (aborted = true) }) });
		expect(await downloadFile("nope.pdf")).toBe(false);
		expect(aborted).toBe(true);
	});

	it("refuses a file too big to hold in memory when it cannot be streamed to disk", async () => {
		const reads = serve(MEMORY_LIMIT + 1);
		expect(await downloadFile("huge.zip")).toBe(false);
		expect(reads).toHaveLength(0);
	});
});

describe("mentioned paths", () => {
	it("recognises file-like inline code and nothing else", () => {
		for (const ok of ["report.xlsx", "out/数据.csv", "C:\\Users\\me\\a.docx", "./build/app.zip", "~/notes.md"]) expect(looksLikeFilePath(ok)).toBe(true);
		for (const no of ["console.log", "foo()", "https://x.com/a.pdf", "a b.pdf", "x.", "report", "a.xlsx?x=1", ".pdf"]) expect(looksLikeFilePath(no)).toBe(false);
	});

	it("asks the server once per path, and asks again after a failed lookup", async () => {
		let calls = 0;
		const client = { subscribe: () => undefined, unsubscribe: () => undefined, rpc: async () => (calls++, { exists: true }) };
		useStore.setState({ client: client as never });
		expect(await fileExists("s9", "a.pdf")).toBe(true);
		expect(await fileExists("s9", "a.pdf")).toBe(true);
		expect(calls).toBe(1);

		let n = 0;
		const flaky = { subscribe: () => undefined, unsubscribe: () => undefined, rpc: async () => { if (n++ === 0) throw new Error("down"); return { exists: true }; } };
		useStore.setState({ client: flaky as never });
		expect(await fileExists("s9", "b.pdf")).toBe(false);
		expect(await fileExists("s9", "b.pdf")).toBe(true);
	});

	it("names files by their last path segment", () => {
		expect(baseName("a/b/c.txt")).toBe("c.txt");
		expect(baseName("C:\\x\\y.docx")).toBe("y.docx");
		expect(baseName("dir/")).toBe("dir");
	});
});
