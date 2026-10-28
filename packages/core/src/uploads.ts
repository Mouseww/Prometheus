// Files attached to a message that the model cannot read directly (Word, Excel, PowerPoint, PDF, HTML, ...). They are put
// in a temporary folder and the model is told their paths, so it can open them with its own tools (a shell, a script,
// a reader plugin). One folder per session; deleting the session deletes its folder, and old folders are pruned at start.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { AppError, type AttachedFile, type SavedAttachment } from "@prometheus/protocol";

export const UPLOAD_ROOT = join(tmpdir(), "prometheus-uploads");
export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** One request carries all the files base64-encoded in a single frame, which the server caps at 32 MB. */
export const MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
const MAX_NAME = 120;
const KEEP_DAYS = 14;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name that is safe as a single path segment on every platform and still recognisable. */
export function safeFileName(name: string): string {
	let n = basename(String(name).replace(/\\/g, "/"))
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f<>:"|?*]/g, "_")
		.replace(/[. ]+$/g, "")
		.trim();
	if (!n || n === "." || n === "..") n = "file";
	if (RESERVED.test(n)) n = `_${n}`;
	if (n.length > MAX_NAME) {
		const dot = n.lastIndexOf(".");
		const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : "";
		n = n.slice(0, MAX_NAME - ext.length) + ext;
	}
	return n;
}

function decode(f: AttachedFile): Buffer {
	if (typeof f?.name !== "string" || typeof f.data !== "string") throw new AppError("fileBadBase64", { name: String(f?.name ?? "") });
	// Buffer.from is lenient about stray characters; a length check against the canonical alphabet catches garbage.
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.data.replace(/\s+/g, ""))) throw new AppError("fileBadBase64", { name: f.name });
	return Buffer.from(f.data, "base64");
}

/** Validates and stores the files of one message; returns where each went. */
export async function saveAttachments(sessionId: string, files: readonly AttachedFile[], root: string = UPLOAD_ROOT): Promise<SavedAttachment[]> {
	if (!files.length) return [];
	if (files.length > MAX_FILES) throw new AppError("filesTooMany", { max: MAX_FILES });
	const buffers: Buffer[] = [];
	let total = 0;
	for (const f of files) {
		const data = decode(f);
		if (data.length > MAX_FILE_BYTES) throw new AppError("fileTooLarge", { name: f.name, max: MAX_FILE_BYTES / (1024 * 1024) });
		total += data.length;
		buffers.push(data);
	}
	if (total > MAX_TOTAL_FILE_BYTES) throw new AppError("filesTotalTooLarge", { max: MAX_TOTAL_FILE_BYTES / (1024 * 1024) });

	// Session ids are uuids; anything else must not become a path.
	const dir = resolve(root, String(sessionId).replace(/[^\w-]/g, "_"));
	if (!dir.startsWith(resolve(root) + sep)) throw new AppError("generic");
	await mkdir(dir, { recursive: true });
	const saved: SavedAttachment[] = [];
	for (const [i, f] of files.entries()) {
		const name = safeFileName(f.name);
		// A random prefix keeps two uploads of "report.xlsx" apart, and the original name stays readable after it.
		const path = join(dir, `${randomBytes(3).toString("hex")}-${name}`);
		await writeFile(path, buffers[i]!);
		saved.push({ name, size: buffers[i]!.length, path });
	}
	return saved;
}

export async function removeSessionUploads(sessionId: string, root: string = UPLOAD_ROOT): Promise<void> {
	const dir = resolve(root, String(sessionId).replace(/[^\w-]/g, "_"));
	if (!dir.startsWith(resolve(root) + sep)) return;
	await rm(dir, { recursive: true, force: true });
}

/** Removes the folders of conversations nobody touched for a while (their sessions may be long gone). */
export async function pruneUploads(root: string = UPLOAD_ROOT, now: number = Date.now()): Promise<number> {
	let removed = 0;
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return 0;
	}
	for (const n of names) {
		const dir = join(root, n);
		try {
			const info = await stat(dir);
			if (now - info.mtimeMs > KEEP_DAYS * 24 * 3600 * 1000) {
				await rm(dir, { recursive: true, force: true });
				removed++;
			}
		} catch {
			/* raced with another prune or already gone */
		}
	}
	return removed;
}
