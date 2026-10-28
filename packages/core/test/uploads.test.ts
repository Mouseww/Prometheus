// Documents attached to a message are stored in a temporary folder and the model is told where.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAttachmentNote, splitAttachmentNote, withAttachmentNote } from "@prometheus/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, pruneUploads, removeSessionUploads, safeFileName, saveAttachments } from "../src/uploads.ts";

let root: string;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "prom-uploads-"));
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

describe("saveAttachments", () => {
	it("stores each file byte for byte under the session's folder and reports where", async () => {
		const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
		const [a, b] = await saveAttachments("sess-1", [{ name: "报告 Q1.xlsx", data: b64(bytes) }, { name: "notes.txt", data: b64("hello") }], root);
		expect(readFileSync(a!.path)).toEqual(bytes);
		expect(a!.name).toBe("报告 Q1.xlsx");
		expect(a!.size).toBe(7);
		expect(readFileSync(b!.path, "utf8")).toBe("hello");
		expect(a!.path.startsWith(join(root, "sess-1"))).toBe(true);
	});

	it("keeps two uploads with the same name apart", async () => {
		const [a, b] = await saveAttachments("sess-2", [{ name: "r.pdf", data: b64("1") }, { name: "r.pdf", data: b64("2") }], root);
		expect(a!.path).not.toBe(b!.path);
		expect(readFileSync(a!.path, "utf8")).toBe("1");
		expect(readFileSync(b!.path, "utf8")).toBe("2");
	});

	it("never lets a name or a session id leave the folder", async () => {
		const [evil] = await saveAttachments("../../escape", [{ name: "../../../etc/passwd", data: b64("x") }], root);
		expect(evil!.path.startsWith(root)).toBe(true);
		expect(evil!.name).toBe("passwd");
		expect(existsSync(join(root, "..", "escape"))).toBe(false);
	});

	it("rejects too many, too large, and invalid files", async () => {
		await expect(saveAttachments("s", Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: b64("x") })), root)).rejects.toMatchObject({ code: "filesTooMany" });
		await expect(saveAttachments("s", [{ name: "big.bin", data: b64(Buffer.alloc(MAX_FILE_BYTES + 1)) }], root)).rejects.toMatchObject({ code: "fileTooLarge" });
		await expect(saveAttachments("s", [{ name: "x", data: "!!not base64!!" }], root)).rejects.toMatchObject({ code: "fileBadBase64" });
		await expect(saveAttachments("s", [{ name: "a", data: b64(Buffer.alloc(12 * 1024 * 1024)) }, { name: "b", data: b64(Buffer.alloc(12 * 1024 * 1024)) }], root)).rejects.toMatchObject({ code: "filesTotalTooLarge" });
	});

	it("deletes a session's folder, and prunes folders nobody touched for weeks", async () => {
		const [f] = await saveAttachments("sess-del", [{ name: "a.txt", data: b64("x") }], root);
		await removeSessionUploads("sess-del", root);
		expect(existsSync(f!.path)).toBe(false);

		const [old] = await saveAttachments("sess-old", [{ name: "a.txt", data: b64("x") }], root);
		const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
		await utimes(join(root, "sess-old"), longAgo, longAgo);
		const [fresh] = await saveAttachments("sess-fresh", [{ name: "a.txt", data: b64("x") }], root);
		await pruneUploads(root);
		expect(existsSync(old!.path)).toBe(false);
		expect(existsSync(fresh!.path)).toBe(true);
	});
});

describe("safeFileName", () => {
	it("keeps readable names and defuses the dangerous ones", () => {
		expect(safeFileName("季度 报告 (final).docx")).toBe("季度 报告 (final).docx");
		expect(safeFileName("a/b\\c.txt")).toBe("c.txt");
		expect(safeFileName('we<ir>d:"n|a?m*e.pdf')).toBe("we_ir_d__n_a_m_e.pdf");
		expect(safeFileName("..")).toBe("file");
		expect(safeFileName("CON.txt")).toBe("_CON.txt");
		expect(safeFileName("trailing. ")).toBe("trailing");
		expect(safeFileName(`${"x".repeat(300)}.xlsx`).length).toBeLessThanOrEqual(120);
		expect(safeFileName(`${"x".repeat(300)}.xlsx`).endsWith(".xlsx")).toBe(true);
	});
});

describe("attachment note", () => {
	const files = [
		{ name: "报告 (v2).xlsx", size: 1234, path: "/tmp/x/ab12-报告 (v2).xlsx" },
		{ name: "a.pdf", size: 5, path: "C:\\Temp\\p\\ab-a.pdf" },
	];

	it("reads back what was written, with the typed text apart", () => {
		const sent = withAttachmentNote("请汇总\n\n两个文件", files);
		expect(sent).toContain(formatAttachmentNote(files));
		expect(splitAttachmentNote(sent)).toEqual({ text: "请汇总\n\n两个文件", files });
	});

	it("works when the message is only files", () => {
		expect(splitAttachmentNote(withAttachmentNote("", files))).toEqual({ text: "", files });
	});

	it("leaves ordinary messages, and look-alikes with other lines after the header, alone", () => {
		expect(splitAttachmentNote("just text")).toEqual({ text: "just text", files: [] });
		const fake = `${formatAttachmentNote(files)}\nand then I kept talking`;
		expect(splitAttachmentNote(fake)).toEqual({ text: fake, files: [] });
		expect(withAttachmentNote("hi", [])).toBe("hi");
	});
});
