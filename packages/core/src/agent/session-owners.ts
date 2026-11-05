// Who owns each conversation, when a trusted issuer vouched for the creator. Kept apart from the session index so it
// covers every runtime. Written the same way as PermissionStore: queued, temp file then rename.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface OwnersFile {
	version: 1;
	owners: Record<string, string>;
}

export class OwnerStore {
	private owners = new Map<string, string>();
	private writing: Promise<void> = Promise.resolve();
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<void> {
		if (!existsSync(this.file)) return;
		try {
			const data = JSON.parse(await readFile(this.file, "utf8")) as Partial<OwnersFile>;
			const owners = data.owners && typeof data.owners === "object" ? data.owners : {};
			this.owners = new Map(Object.entries(owners).filter((e): e is [string, string] => typeof e[1] === "string"));
		} catch {
			this.owners = new Map();
		}
	}

	get(id: string): string | undefined {
		return this.owners.get(id);
	}

	set(id: string, userId: string): void {
		if (this.owners.get(id) === userId) return;
		this.owners.set(id, userId);
		this.save();
	}

	delete(id: string): void {
		if (this.owners.delete(id)) this.save();
	}

	flush(): Promise<void> {
		return this.writing;
	}

	private save(): void {
		const body = JSON.stringify({ version: 1, owners: Object.fromEntries(this.owners) } satisfies OwnersFile);
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
