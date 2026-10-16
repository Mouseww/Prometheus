import type { ImageContent } from "@prometheus/protocol";

export const MAX_IMAGES = 6;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_ACCEPT = TYPES.join(",");
/** Longest edge sent to the model; providers downscale anyway, so more only costs upload and tokens. */
const MAX_EDGE = 2048;
/** Files at or under this size and edge go through untouched, keeping animation and exact pixels. */
const KEEP_BYTES = 3 * 1024 * 1024;
const REFUSE_BYTES = 25 * 1024 * 1024;

export const isImageFile = (f: Pick<File, "type">): boolean => TYPES.includes(f.type);

/** Size after shrinking so the longest edge is at most `max`; never enlarges. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number; scaled: boolean } {
	const scale = Math.min(1, max / Math.max(width, height, 1));
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scaled: scale < 1 };
}

export const imageSrc = (i: Pick<ImageContent, "data" | "mimeType">): string => `data:${i.mimeType};base64,${i.data}`;

function readBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("读取图片失败"));
		reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
		reader.readAsDataURL(blob);
	});
}

export type ImageRefusal = "type" | "size" | "decode";

export class ImageError extends Error {
	readonly reason: ImageRefusal;
	constructor(reason: ImageRefusal) {
		super(reason);
		this.reason = reason;
	}
}

/** Turn a picked, pasted or dropped file into message content, shrinking large photos. */
export async function fileToImage(file: File): Promise<ImageContent> {
	if (!isImageFile(file)) throw new ImageError("type");
	if (file.size > REFUSE_BYTES) throw new ImageError("size");
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		throw new ImageError("decode");
	}
	try {
		const fit = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
		if (!fit.scaled && file.size <= KEEP_BYTES) return { type: "image", data: await readBase64(file), mimeType: file.type };

		const canvas = document.createElement("canvas");
		canvas.width = fit.width;
		canvas.height = fit.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new ImageError("decode");
		// JPEG has no alpha; transparent pixels would turn black.
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, fit.width, fit.height);
		ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
		if (!blob) throw new ImageError("decode");
		// Re-encoding an unscaled picture can grow it; keep whichever is smaller.
		if (!fit.scaled && blob.size >= file.size) return { type: "image", data: await readBase64(file), mimeType: file.type };
		return { type: "image", data: await readBase64(blob), mimeType: "image/jpeg" };
	} finally {
		bitmap.close();
	}
}

/** Image blocks of a tool result in either wire shape (`{content:[...]}` or a bare content array). */
export function imagesOf(value: unknown): ImageContent[] {
	const content = Array.isArray(value) ? value : (value as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((c): c is ImageContent => c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string");
}
