import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** One line per action the agent took. Values typed are never stored, only their length. */
export interface AuditEntry {
	time: string;
	session?: string;
	device: string;
	app: string;
	window: string;
	op: string;
	ref?: string;
	role?: string;
	name?: string;
	valueLength?: number;
	method?: string;
	ok: boolean;
	error?: string;
	/** Why a confirmation was required, and how it was settled. */
	guard?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

export class AuditLog {
	private queue: Promise<void> = Promise.resolve();

	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	write(entry: Omit<AuditEntry, "time">): void {
		const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
		this.queue = this.queue
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				const size = (await stat(this.path).catch(() => undefined))?.size ?? 0;
				if (size > MAX_BYTES) await rename(this.path, `${this.path}.1`).catch(() => {});
				await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
			})
			.catch(() => {});
	}

	flush(): Promise<void> {
		return this.queue;
	}
}
