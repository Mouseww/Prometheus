// Letting the user download a file an agent made or was given. The server may be reachable from other machines, so
// a path is only served from the places the conversation works in: its own folder and the folder its uploads went to.
// (Not the system temp folder as a whole: it holds other programs' files.) Links are resolved first, so a symlink in
// the workspace cannot point outside; anything else looks exactly like a file that does not exist.
import { randomUUID } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { AppError } from "@prometheus/protocol";

/** Bytes returned per read call. The client asks for the next piece until the file ends. */
export const MAX_CHUNK = 4 * 1024 * 1024;

export interface Downloadable {
	path: string;
	name: string;
	size: number;
}

const same = process.platform === "win32" ? (s: string) => s.toLowerCase() : (s: string) => s;

function inside(root: string, file: string): boolean {
	const rel = relative(same(root), same(file));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** The real file behind `requested` when it is a regular file under one of `roots`; undefined otherwise. */
export async function resolveDownload(requested: string, cwd: string, roots: readonly string[]): Promise<Downloadable | undefined> {
	if (typeof requested !== "string" || !requested.trim() || requested.includes("\0")) return undefined;
	let real: string;
	try {
		real = await realpath(resolve(cwd, requested));
	} catch {
		return undefined;
	}
	const allowed: string[] = [];
	for (const r of [cwd, ...roots]) {
		try {
			allowed.push(await realpath(r));
		} catch {
			/* a root that does not exist serves nothing */
		}
	}
	if (!allowed.some((r) => inside(r, real))) return undefined;
	try {
		const info = await stat(real);
		if (!info.isFile()) return undefined;
		return { path: real, name: basename(real), size: info.size };
	} catch {
		return undefined;
	}
}

export async function readChunk(file: Downloadable, offset: number, length: number): Promise<{ data: string; size: number; eof: boolean }> {
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) throw new AppError("generic");
	const want = Math.min(length, MAX_CHUNK, Math.max(0, file.size - offset));
	if (want === 0) return { data: "", size: file.size, eof: true };
	const handle = await open(file.path, "r");
	try {
		const buf = Buffer.alloc(want);
		const { bytesRead } = await handle.read(buf, 0, want, offset);
		return { data: buf.subarray(0, bytesRead).toString("base64"), size: file.size, eof: offset + bytesRead >= file.size };
	} finally {
		await handle.close();
	}
}

const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, { file: Downloadable; expires: number }>();

/** A one-time id under which `file` may be fetched over plain HTTP for a short while. */
export function issueTicket(file: Downloadable): string {
	const now = Date.now();
	for (const [id, t] of tickets) if (t.expires < now) tickets.delete(id);
	const id = randomUUID();
	tickets.set(id, { file, expires: now + TICKET_TTL_MS });
	return id;
}

/** The file behind a ticket, or undefined when unknown or expired. Tickets are single-use. */
export function takeTicket(id: string): Downloadable | undefined {
	const t = tickets.get(id);
	tickets.delete(id);
	return t && t.expires >= Date.now() ? t.file : undefined;
}

/** Folders that, besides the conversation's own, may be downloaded from. */
export function extraRoots(uploadRoot: string): string[] {
	return [uploadRoot];
}
