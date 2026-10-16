import { describe, expect, it } from "vitest";
import { fitWithin, imagesOf, imageSrc, isImageFile } from "../src/lib/images.ts";

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
	it("accepts only the formats providers take", () => {
		for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(isImageFile({ type: t })).toBe(true);
		for (const t of ["image/svg+xml", "image/bmp", "application/pdf", ""]) expect(isImageFile({ type: t })).toBe(false);
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
