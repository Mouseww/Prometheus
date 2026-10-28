// Downloading a file from a conversation: only from the places it works in, in pieces, byte for byte.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_CHUNK, readChunk, resolveDownload } from "../src/downloads.ts";

let root: string;
let work: string;
let outside: string;
let uploads: string;
const bytes = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prom-dl-"));
	work = join(root, "work");
	outside = join(root, "outside");
	uploads = join(root, "uploads");
	for (const d of [work, join(work, "out"), outside, uploads]) mkdirSync(d, { recursive: true });
	writeFileSync(join(work, "out", "报告.xlsx"), bytes);
	writeFileSync(join(outside, "secret.txt"), "secret");
	writeFileSync(join(uploads, "a-upload.pdf"), "pdf");
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("resolveDownload", () => {
	it("serves a file inside the conversation's folder, by relative or absolute path", async () => {
		const rel = await resolveDownload("out/报告.xlsx", work, []);
		expect(rel).toMatchObject({ name: "报告.xlsx", size: 10_000 });
		const abs = await resolveDownload(join(work, "out", "报告.xlsx"), work, []);
		expect(abs?.path).toBe(rel?.path);
	});

	it("serves the extra folders it is given", async () => {
		expect((await resolveDownload(join(uploads, "a-upload.pdf"), work, [uploads]))?.name).toBe("a-upload.pdf");
	});

	it("treats everything else like a file that does not exist", async () => {
		expect(await resolveDownload(join(outside, "secret.txt"), work, [uploads])).toBeUndefined();
		expect(await resolveDownload("../outside/secret.txt", work, [])).toBeUndefined();
		expect(await resolveDownload("out", work, [])).toBeUndefined(); // a folder
		expect(await resolveDownload("missing.txt", work, [])).toBeUndefined();
		expect(await resolveDownload("", work, [])).toBeUndefined();
		expect(await resolveDownload("a\0b", work, [])).toBeUndefined();
	});

	it("does not follow a link out of the folder", async () => {
		try {
			symlinkSync(join(outside, "secret.txt"), join(work, "link.txt"));
		} catch {
			return; // creating symlinks needs privileges on some Windows setups
		}
		expect(await resolveDownload("link.txt", work, [])).toBeUndefined();
	});
});

describe("readChunk", () => {
	it("returns the file in pieces that add up to the original", async () => {
		const file = (await resolveDownload("out/报告.xlsx", work, []))!;
		const parts: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const piece = await readChunk(file, offset, 3000);
			parts.push(Buffer.from(piece.data, "base64"));
			offset += parts[parts.length - 1]!.length;
			if (piece.eof) break;
		}
		expect(parts.length).toBe(4);
		expect(Buffer.concat(parts)).toEqual(bytes);
	});

	it("never returns more than the cap, and reports the end", async () => {
		const file = (await resolveDownload("out/报告.xlsx", work, []))!;
		expect(Buffer.from((await readChunk(file, 0, MAX_CHUNK * 10)).data, "base64").length).toBe(10_000);
		expect(await readChunk(file, 10_000, 100)).toEqual({ data: "", size: 10_000, eof: true });
	});

	it("rejects nonsense ranges", async () => {
		const file = (await resolveDownload("out/报告.xlsx", work, []))!;
		await expect(readChunk(file, -1, 10)).rejects.toThrow();
		await expect(readChunk(file, 0, 0)).rejects.toThrow();
		await expect(readChunk(file, 1.5, 10)).rejects.toThrow();
	});
});
