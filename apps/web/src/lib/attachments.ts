// Documents attached to a message (Word, Excel, PowerPoint, PDF, text, HTML, archives, ...). Pictures keep their own path
// (they are shown to a vision model); everything else is sent as bytes, stored on the server in a temporary folder, and
// the model is told the path. The limits mirror the server's.
import type { AttachedFile } from "@prometheus/protocol";

export const MAX_FILES = 10;
export const MAX_FILE_MB = 20;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
export const MAX_TOTAL_BYTES = MAX_FILE_BYTES;

/** A file waiting in the composer: the wire form plus its size, for the chip. */
export interface Attachment extends AttachedFile {
	size: number;
}

export type AttachmentRefusal = "size" | "total" | "read";

export class AttachmentError extends Error {
	readonly reason: AttachmentRefusal;
	constructor(reason: AttachmentRefusal) {
		super(reason);
		this.reason = reason;
	}
}

/** True for the pictures the image path handles (PNG, JPEG, GIF, WebP); other image types, like SVG or TIFF, go as files. */
export function isPicture(file: { type: string; name?: string }): boolean {
	return /^image\/(png|jpe?g|gif|webp)$/i.test(file.type) || (!file.type && /\.(png|jpe?g|gif|webp)$/i.test(file.name ?? ""));
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Base64 of the whole file, without the `data:...;base64,` prefix. Chunked so a big file does not blow the argument limit. */
export async function readBase64(file: Blob): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const STEP = 0x8000;
	for (let i = 0; i < bytes.length; i += STEP) binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
	return btoa(binary);
}

/** Checks one file against the limits, given what is already attached, and reads it. */
export async function fileToAttachment(file: File, alreadyBytes: number): Promise<Attachment> {
	if (file.size > MAX_FILE_BYTES) throw new AttachmentError("size");
	if (alreadyBytes + file.size > MAX_TOTAL_BYTES) throw new AttachmentError("total");
	try {
		return { name: file.name || "file", ...(file.type ? { mimeType: file.type } : {}), data: await readBase64(file), size: file.size };
	} catch {
		throw new AttachmentError("read");
	}
}

/** What goes over the wire. */
export const toWire = (list: readonly Attachment[]): AttachedFile[] => list.map(({ name, mimeType, data }) => ({ name, ...(mimeType ? { mimeType } : {}), data }));
