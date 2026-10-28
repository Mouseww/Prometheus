import { describe, expect, it } from "vitest";
import { AttachmentError, fileToAttachment, formatSize, isPicture, MAX_FILE_BYTES, readBase64, toWire } from "../src/lib/attachments.ts";

const file = (name: string, bytes: number | Uint8Array, type = "") => new File([typeof bytes === "number" ? new Uint8Array(bytes) : bytes], name, { type });

describe("isPicture", () => {
	it("sends only PNG, JPEG, GIF and WebP down the picture path", () => {
		for (const t of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]) expect(isPicture({ type: t })).toBe(true);
		for (const t of ["image/svg+xml", "image/tiff", "application/pdf", "text/html"]) expect(isPicture({ type: t })).toBe(false);
	});

	it("falls back to the extension when the browser gave no type", () => {
		expect(isPicture({ type: "", name: "shot.PNG" })).toBe(true);
		expect(isPicture({ type: "", name: "report.docx" })).toBe(false);
	});
});

describe("formatSize", () => {
	it("is short and readable", () => {
		expect(formatSize(512)).toBe("512 B");
		expect(formatSize(1536)).toBe("1.5 KB");
		expect(formatSize(300 * 1024)).toBe("300 KB");
		expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
	});
});

describe("reading files", () => {
	it("encodes every byte, including the large ones, and the name and type travel with it", async () => {
		const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 256);
		const att = await fileToAttachment(file("数据.xlsx", bytes, "application/vnd.ms-excel"), 0);
		expect(att).toMatchObject({ name: "数据.xlsx", mimeType: "application/vnd.ms-excel", size: 100_000 });
		expect(Uint8Array.from(atob(att.data), (c) => c.charCodeAt(0))).toEqual(bytes);
		expect(await readBase64(new Blob([]))).toBe("");
	});

	it("leaves out the type when the browser has none", async () => {
		const att = await fileToAttachment(file("x.bin", 3), 0);
		expect(att.mimeType).toBeUndefined();
		expect(toWire([att])[0]).not.toHaveProperty("size");
		expect(toWire([att])[0]).not.toHaveProperty("mimeType");
	});

	it("refuses a file over the limit, and one that would push the total over it", async () => {
		await expect(fileToAttachment(file("big.pdf", MAX_FILE_BYTES + 1), 0)).rejects.toMatchObject({ reason: "size" });
		await expect(fileToAttachment(file("b.pdf", 2 * 1024 * 1024), MAX_FILE_BYTES - 1024)).rejects.toBeInstanceOf(AttachmentError);
		await expect(fileToAttachment(file("b.pdf", 2 * 1024 * 1024), MAX_FILE_BYTES - 1024)).rejects.toMatchObject({ reason: "total" });
	});
});
