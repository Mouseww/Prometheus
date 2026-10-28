import { ATTACHMENT_HEADER, goalTitle } from "@prometheus/protocol";
import { AppError, encodeError, type ImageContent } from "@prometheus/protocol";

export const MAX_IMAGES = 10;
/** Base64 characters per image (about 25 MB of bytes). */
export const MAX_IMAGE_CHARS = 34 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_CHARS = 80 * 1024 * 1024;
const MIME = /^image\/(png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** PI titles a chat by its first text; a chat that opened with only pictures would read "(no messages)". */
export function imageOnlyTitle(firstMessage: string, messageCount: number): string {
	return firstMessage === "(no messages)" && messageCount > 0 ? "i18n:imageOnlyTitle" : firstMessage;
}

/** PI auto-resize needs Photon WASM; a failed load drops every picture. Skip that pass without writing settings.json. */
export function skipPiImageAutoResize(settings: { getImageAutoResize: () => boolean }): void {
	settings.getImageAutoResize = () => false;
}

/** Reject what a provider would, before it is stored in the session and sent upstream. */
export function checkImages(images: readonly ImageContent[] | undefined): void {
	if (!images?.length) return;
	if (!Array.isArray(images)) throw new AppError("imagesInvalid");
	if (images.length > MAX_IMAGES) throw new AppError("imagesTooMany", { max: MAX_IMAGES });
	let total = 0;
	for (const img of images) {
		if (img?.type !== "image" || typeof img.data !== "string" || typeof img.mimeType !== "string") throw new AppError("imagesInvalid");
		if (!MIME.test(img.mimeType)) throw new AppError("imageType");
		if (img.data.length > MAX_IMAGE_CHARS) throw new AppError("imageTooLarge");
		if (!img.data || !BASE64.test(img.data)) throw new AppError("imageBadBase64");
		total += img.data.length;
	}
	if (total > MAX_TOTAL_IMAGE_CHARS) throw new AppError("imagesTotalTooLarge");
}

/** A conversation's title when its first message carried files: the words typed, else the first file's name, never the note about paths. */
export function titleWithoutNote(firstMessage: string): string {
	// A conversation that began with /goal is named after its objective, not the instructions around it.
	const goal = goalTitle(firstMessage);
	if (goal !== null) return goal;
	let at = firstMessage.indexOf(ATTACHMENT_HEADER);
	if (at < 0) {
		// A first message cut short inside the header itself.
		const cut = firstMessage.lastIndexOf("\n\n") + 2;
		const tail = firstMessage.slice(cut > 1 ? cut : 0);
		if (tail.length < 8 || !ATTACHMENT_HEADER.startsWith(tail)) return firstMessage;
		at = cut > 1 ? cut : 0;
	}
	const typed = firstMessage.slice(0, at).trim();
	if (typed) return typed;
	const first = /^- (.*?) \(\d+ bytes\)/m.exec(firstMessage.slice(at));
	return first?.[1] ?? "file";
}
