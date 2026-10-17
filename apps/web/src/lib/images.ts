import type { ImageContent } from "@prometheus/protocol";

export const MAX_IMAGES = 6;
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
/** Android photo pickers often omit MIME or send `image/jpg` / `application/octet-stream`; keep aliases and extensions. */
/** `image/*` is what Android WebView's picker actually honours; a long MIME/extension list can open empty. */
export const IMAGE_ACCEPT = "image/*";
/** Longest edge sent to the model; providers downscale anyway, so more only costs upload and tokens. */
const MAX_EDGE = 2048;
/** Files at or under this size and edge go through untouched, keeping animation and exact pixels. */
const KEEP_BYTES = 3 * 1024 * 1024;
const REFUSE_BYTES = 25 * 1024 * 1024;

const MIME_BY_TYPE: Record<string, ImageMime> = {
	"image/png": "image/png",
	"image/x-png": "image/png",
	"image/jpeg": "image/jpeg",
	"image/jpg": "image/jpeg",
	"image/pjpeg": "image/jpeg",
	"image/gif": "image/gif",
	"image/webp": "image/webp",
	"image/x-webp": "image/webp",
};

const MIME_BY_EXT: Record<string, ImageMime> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

const starts = (bytes: Uint8Array, sig: number[]) => sig.every((b, i) => bytes[i] === b);

/** Magic-number sniff so Android's empty / octet-stream MIME still counts as an image. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | undefined {
	if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	if (bytes.length >= 12 && starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp";
}

export function imageMimeOf(file: Pick<File, "type" | "name">, bytes?: Uint8Array): ImageMime | undefined {
	// Bytes first: Android often names HEIC `IMG_0001.jpg` and leaves MIME empty.
	if (bytes) {
		const sniffed = sniffImageMime(bytes);
		if (sniffed) return sniffed;
	}
	const fromType = MIME_BY_TYPE[file.type.toLowerCase().split(";")[0]?.trim() ?? ""];
	if (fromType) return fromType;
	const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
	if (ext && ext !== file.name.toLowerCase()) return MIME_BY_EXT[ext];
}

export const isImageFile = (f: Pick<File, "type" | "name">): boolean => Boolean(imageMimeOf(f));

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

async function canvasToJpeg(canvas: HTMLCanvasElement): Promise<{ data: string; bytes: number }> {
	const blob = await new Promise<Blob | null>((resolve) => {
		if (typeof canvas.toBlob === "function") canvas.toBlob(resolve, "image/jpeg", 0.88);
		else resolve(null);
	});
	if (blob) return { data: await readBase64(blob), bytes: blob.size };
	const url = canvas.toDataURL("image/jpeg", 0.88);
	const data = url.split(",")[1] ?? "";
	if (!data) throw new ImageError("decode");
	return { data, bytes: Math.ceil((data.length * 3) / 4) };
}

async function decodeImage(file: File): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close: () => void }> {
	try {
		const bitmap = await createImageBitmap(file);
		return { width: bitmap.width, height: bitmap.height, draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h), close: () => bitmap.close() };
	} catch {
		// Android WebView / content URIs often reject createImageBitmap; HTMLImageElement still works.
		const url = URL.createObjectURL(file);
		try {
			const img = await new Promise<HTMLImageElement>((resolve, reject) => {
				const el = new Image();
				el.onload = () => resolve(el);
				el.onerror = () => reject(new ImageError("decode"));
				el.src = url;
			});
			return { width: img.naturalWidth, height: img.naturalHeight, draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h), close: () => URL.revokeObjectURL(url) };
		} catch (err) {
			URL.revokeObjectURL(url);
			throw err;
		}
	}
}

/** Turn a picked, pasted or dropped file into message content, shrinking large photos. */
export async function fileToImage(file: File): Promise<ImageContent> {
	if (file.size > REFUSE_BYTES) throw new ImageError("size");
	let head = new Uint8Array();
	try {
		head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
	} catch {
		/* some Android content URIs refuse slice; sniffing is optional */
	}
	const sniffed = sniffImageMime(head);
	const mime = sniffed ?? imageMimeOf(file);
	let decoded: Awaited<ReturnType<typeof decodeImage>>;
	try {
		decoded = await decodeImage(file);
	} catch (err) {
		if (err instanceof ImageError) throw err;
		throw new ImageError(mime ? "decode" : "type");
	}
	try {
		const fit = fitWithin(decoded.width, decoded.height, MAX_EDGE);
		// Keep original bytes only when the header matches a provider MIME; a .jpg that is actually HEIC must be re-encoded.
		if (sniffed && !fit.scaled && file.size <= KEEP_BYTES) return { type: "image", data: await readBase64(file), mimeType: sniffed };

		const canvas = document.createElement("canvas");
		canvas.width = fit.width;
		canvas.height = fit.height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new ImageError("decode");
		// JPEG has no alpha; transparent pixels would turn black.
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, fit.width, fit.height);
		decoded.draw(ctx, fit.width, fit.height);
		const encoded = await canvasToJpeg(canvas);
		// Re-encoding an unscaled picture can grow it; keep whichever is smaller.
		if (sniffed && !fit.scaled && encoded.bytes >= file.size) return { type: "image", data: await readBase64(file), mimeType: sniffed };
		return { type: "image", data: encoded.data, mimeType: "image/jpeg" };
	} finally {
		decoded.close();
	}
}

/** Image blocks of a tool result in either wire shape (`{content:[...]}` or a bare content array). */
export function imagesOf(value: unknown): ImageContent[] {
	const content = Array.isArray(value) ? value : (value as { content?: unknown } | null | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((c): c is ImageContent => c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string");
}
