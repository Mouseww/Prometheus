import type { ImageContent } from "@prometheus/protocol";

export const MAX_IMAGES = 10;
/** Base64 characters per image (about 25 MB of bytes). */
export const MAX_IMAGE_CHARS = 34 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_CHARS = 80 * 1024 * 1024;
const MIME = /^image\/(png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** PI titles a chat by its first text; a chat that opened with only pictures would read "(no messages)". */
export function imageOnlyTitle(firstMessage: string, messageCount: number): string {
	return firstMessage === "(no messages)" && messageCount > 0 ? "[图片]" : firstMessage;
}

/** PI auto-resize needs Photon WASM; a failed load drops every picture. Skip that pass without writing settings.json. */
export function skipPiImageAutoResize(settings: { getImageAutoResize: () => boolean }): void {
	settings.getImageAutoResize = () => false;
}

/** Reject what a provider would, before it is stored in the session and sent upstream. */
export function checkImages(images: readonly ImageContent[] | undefined): void {
	if (!images?.length) return;
	if (!Array.isArray(images)) throw new Error("图片格式不正确");
	if (images.length > MAX_IMAGES) throw new Error(`一条消息最多 ${MAX_IMAGES} 张图片`);
	let total = 0;
	for (const img of images) {
		if (img?.type !== "image" || typeof img.data !== "string" || typeof img.mimeType !== "string") throw new Error("图片格式不正确");
		if (!MIME.test(img.mimeType)) throw new Error("只支持 PNG、JPEG、GIF、WebP 图片");
		if (img.data.length > MAX_IMAGE_CHARS) throw new Error("图片过大");
		if (!img.data || !BASE64.test(img.data)) throw new Error("图片数据不是有效的 base64");
		total += img.data.length;
	}
	if (total > MAX_TOTAL_IMAGE_CHARS) throw new Error("图片总体积过大");
}
