import { describe, expect, it } from "vitest";
import { checkImages, imageOnlyTitle, MAX_IMAGES, skipPiImageAutoResize } from "../src/images.ts";

describe("imageOnlyTitle", () => {
	it("replaces PI's empty placeholder only for chats that have messages", () => {
		expect(imageOnlyTitle("(no messages)", 3)).toBe("i18n:imageOnlyTitle");
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
		for (const mimeType of ["image/svg+xml", "text/html", "application/pdf", "image/png; x=1"]) expect(() => checkImages([img({ mimeType })])).toThrow("imageType");
	});

	it("refuses data that is not base64, or empty", () => {
		expect(() => checkImages([img({ data: "not base64!" })])).toThrow("imageBadBase64");
		expect(() => checkImages([img({ data: "" })])).toThrow("imageBadBase64");
		expect(() => checkImages([img({ data: "data:image/png;base64,QUJD" })])).toThrow("imageBadBase64");
	});

	it("refuses too many images and malformed entries", () => {
		expect(() => checkImages(Array.from({ length: MAX_IMAGES + 1 }, () => img()))).toThrow("imagesTooMany");
		expect(() => checkImages([{ type: "text" } as never])).toThrow("imagesInvalid");
		expect(() => checkImages([null as never])).toThrow("imagesInvalid");
	});
});

import { formatAttachmentNote } from "@prometheus/protocol";
import { titleWithoutNote } from "../src/images.ts";

describe("titleWithoutNote", () => {
	const note = formatAttachmentNote([{ name: "季度报告.xlsx", size: 10, path: "/tmp/p/a-季度报告.xlsx" }]);
	it("uses the typed words when there are some", () => {
		expect(titleWithoutNote(`汇总一下\n\n${note}`)).toBe("汇总一下");
	});
	it("falls back to the first file's name when only files were sent", () => {
		expect(titleWithoutNote(note)).toBe("季度报告.xlsx");
	});
	it("copes with a title cut in the middle of the note, and leaves ordinary titles alone", () => {
		expect(titleWithoutNote(note.slice(0, 80))).toBe("file");
		expect(titleWithoutNote("hello")).toBe("hello");
	});
});
