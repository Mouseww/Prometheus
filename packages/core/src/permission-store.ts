// The permission mode each conversation was last in, so reopening one (after a restart, or from the list) puts it back
// the way the user left it instead of the gate's blank "ask first" state.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PermissionMode } from "@prometheus/protocol";

export class PermissionStore {
	private modes = new Map<string, PermissionMode>();
	private writing: Promise<void> = Promise.resolve();

	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<void> {
		if (!existsSync(this.file)) return;
		try {
			const data = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
			this.modes = new Map(Object.entries(data).filter((e): e is [string, PermissionMode] => typeof e[1] === "string"));
		} catch {
			this.modes = new Map();
		}
	}

	get(id: string): PermissionMode | undefined {
		return this.modes.get(id);
	}

	set(id: string, mode: PermissionMode): void {
		if (this.modes.get(id) === mode) return;
		this.modes.set(id, mode);
		this.save();
	}

	delete(id: string): void {
		if (this.modes.delete(id)) this.save();
	}

	flush(): Promise<void> {
		return this.writing;
	}

	private save(): void {
		const body = JSON.stringify(Object.fromEntries(this.modes));
		this.writing = this.writing
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true });
				const tmp = `${this.file}.tmp`;
				await writeFile(tmp, body, "utf8");
				await rename(tmp, this.file);
			})
			.catch(() => {});
	}
}
