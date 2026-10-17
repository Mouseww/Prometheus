import { describe, expect, it } from "vitest";
import { checkImages, imageOnlyTitle, MAX_IMAGES, skipPiImageAutoResize } from "../src/images.ts";

describe("imageOnlyTitle", () => {
	it("replaces PI's empty placeholder only for chats that have messages", () => {
		expect(imageOnlyTitle("(no messages)", 3)).toBe("[图片]");
		expect(imageOnlyTitle("(no messages)", 0)).toBe("(no messages)");
		expect(imageOnlyTitle("hello", 3)).toBe("hello");
	});
});

const img = (over: Record<string, unknown> = {}) => ({ type: "image" as const, data: "QUJD", mimeType: "image/png", ...over });

describe("skipPiImageAutoResize", () => {
	it("turns auto-resize off on the settings object without calling the setter", () => {
		const settings = {
			getImageAutoResize: () => true,
			setImageAutoResize: (enabled: boolean) => {
				throw new Error(`must not persist autoResize=${enabled}`);
			},
		};
		skipPiImageAutoResize(settings);
		expect(settings.getImageAutoResize()).toBe(false);
	});
});

describe("checkImages", () => {
	it("accepts nothing, and well-formed images", () => {
		expect(() => checkImages(undefined)).not.toThrow();
		expect(() => checkImages([])).not.toThrow();
		expect(() => checkImages([img(), img({ mimeType: "image/jpeg" }), img({ data: "QUI=" })])).not.toThrow();
	});

	it("refuses other mime types, including SVG which can carry script", () => {
		for (const mimeType of ["image/svg+xml", "text/html", "application/pdf", "image/png; x=1"]) expect(() => checkImages([img({ mimeType })])).toThrow(/PNG/);
	});

	it("refuses data that is not base64, or empty", () => {
		expect(() => checkImages([img({ data: "not base64!" })])).toThrow(/base64/);
		expect(() => checkImages([img({ data: "" })])).toThrow(/base64/);
		expect(() => checkImages([img({ data: "data:image/png;base64,QUJD" })])).toThrow(/base64/);
	});

	it("refuses too many images and malformed entries", () => {
		expect(() => checkImages(Array.from({ length: MAX_IMAGES + 1 }, () => img()))).toThrow(/最多/);
		expect(() => checkImages([{ type: "text" } as never])).toThrow(/格式/);
		expect(() => checkImages([null as never])).toThrow(/格式/);
	});
});
