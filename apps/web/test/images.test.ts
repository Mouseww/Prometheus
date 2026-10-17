import { describe, expect, it } from "vitest";
import { fitWithin, imageMimeOf, imagesOf, imageSrc, isImageFile, sniffImageMime } from "../src/lib/images.ts";

describe("fitWithin", () => {
	it("shrinks the longest edge and keeps the aspect ratio", () => {
		expect(fitWithin(4000, 2000, 2048)).toEqual({ width: 2048, height: 1024, scaled: true });
		expect(fitWithin(1000, 3000, 1500)).toEqual({ width: 500, height: 1500, scaled: true });
	});

	it("never enlarges and never returns a zero edge", () => {
		expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600, scaled: false });
		expect(fitWithin(10000, 1, 100).height).toBe(1);
	});
});

describe("isImageFile", () => {
	it("accepts provider formats, aliases, and extensions when MIME is missing", () => {
		for (const t of ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]) expect(isImageFile({ type: t, name: "x" })).toBe(true);
		expect(isImageFile({ type: "", name: "photo.JPG" })).toBe(true);
		expect(isImageFile({ type: "application/octet-stream", name: "shot.webp" })).toBe(true);
		for (const t of ["image/svg+xml", "image/bmp", "application/pdf"]) expect(isImageFile({ type: t, name: "x" })).toBe(false);
		expect(isImageFile({ type: "", name: "notes.txt" })).toBe(false);
		expect(isImageFile({ type: "application/octet-stream", name: "blob" })).toBe(false);
	});
});

describe("imageMimeOf", () => {
	it("normalizes aliases and prefers a sniffed header over a claimed name", () => {
		expect(imageMimeOf({ type: "image/jpg", name: "a.jpg" })).toBe("image/jpeg");
		expect(imageMimeOf({ type: "image/jpeg; charset=binary", name: "a.jpg" })).toBe("image/jpeg");
		expect(imageMimeOf({ type: "", name: "a.png" })).toBe("image/png");
		expect(imageMimeOf({ type: "application/octet-stream", name: "IMG_0001" }, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(imageMimeOf({ type: "image/jpeg", name: "photo.jpg" }, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
	});
});

describe("sniffImageMime", () => {
	it("reads PNG JPEG GIF and WebP magic numbers", () => {
		expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
		expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
		expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
		expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
		expect(sniffImageMime(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBeUndefined();
	});
});

describe("imagesOf", () => {
	const img = { type: "image", data: "AAA", mimeType: "image/png" };
	it("reads images from tool results in both shapes and skips everything else", () => {
		expect(imagesOf({ content: [{ type: "text", text: "x" }, img] })).toEqual([img]);
		expect(imagesOf([img, { type: "image" }])).toEqual([img]);
		expect(imagesOf(undefined)).toEqual([]);
		expect(imagesOf("text")).toEqual([]);
	});
});

describe("imageSrc", () => {
	it("builds a data URL", () => {
		expect(imageSrc({ data: "QUJD", mimeType: "image/png" })).toBe("data:image/png;base64,QUJD");
	});
});
