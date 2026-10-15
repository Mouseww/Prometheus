import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JsonStore<T> {
	read(): Promise<T>;
	/** Read-modify-write under the store's lock, so concurrent updates never lose writes. */
	update(fn: (current: T) => T | Promise<T>): Promise<T>;
}

/**
 * A small JSON file with atomic, serialised writes, written owner-only. Reads always hit the disk
 * so the TUI and the server can share one file.
 */
export function createJsonStore<T>(path: string, fallback: () => T): JsonStore<T> {
	let lock: Promise<unknown> = Promise.resolve();

	const read = async (): Promise<T> => {
		try {
			return JSON.parse(await readFile(path, "utf8")) as T;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return fallback();
		}
	};

	const update = (fn: (current: T) => T | Promise<T>): Promise<T> => {
		const run = async () => {
			const next = await fn(await read());
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
			await rename(tmp, path);
			return next;
		};
		const result = lock.then(run, run);
		lock = result.catch(() => {});
		return result;
	};

	return { read, update };
}
