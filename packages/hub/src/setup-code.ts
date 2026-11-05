import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constantTimeEquals } from "./crypto.ts";
import { LOG_PREFIX, type HubLog } from "./log.ts";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export interface SetupCode {
	/** Creates the code (or reuses the one on disk) and prints it to the log. */
	ensure(log: HubLog): Promise<void>;
	verify(code: string): Promise<boolean>;
	/** Removes the code once the first account exists. */
	clear(): Promise<void>;
}

function generate(): string {
	const bytes = randomBytes(12);
	let out = "";
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
	return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** One-time bootstrap code kept in `<dataDir>/setup-code.txt` (0600) while the users table is empty. */
export function createSetupCode(dataDir: string): SetupCode {
	const path = join(dataDir, "setup-code.txt");
	const read = async (): Promise<string | undefined> => {
		try {
			return (await readFile(path, "utf8")).trim();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	};
	return {
		async ensure(log) {
			let code = await read();
			if (!code) {
				await mkdir(dataDir, { recursive: true });
				code = generate();
				await writeFile(path, `${code}\n`, { mode: 0o600 });
				await chmod(path, 0o600).catch(() => {});
			}
			log.warn(`${LOG_PREFIX} 尚无任何账号。首个账号的设置码: ${code}（同时保存在 ${path}），请在注册页填写。`);
		},
		async verify(code) {
			const expected = await read();
			return expected !== undefined && constantTimeEquals(code.trim().toUpperCase(), expected.toUpperCase());
		},
		async clear() {
			await rm(path, { force: true });
		},
	};
}
