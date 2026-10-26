// Prometheus' own index of sessions that live in a runtime other than PI (docs/agent-runtime.md §3.1).
// PI keeps its sessions on disk and the host lists them from there; Claude Code and Codex keep theirs in their own
// stores, which cannot represent "created but empty", a Prometheus name, or which gateway a session uses. The index does.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GatewayChoice, RuntimeKind } from "@prometheus/protocol";

export interface IndexEntry {
	id: string;
	runtime: RuntimeKind;
	nativeId: string;
	cwd: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	gateway?: GatewayChoice;
}

interface IndexFile {
	version: 1;
	sessions: IndexEntry[];
}

export class SessionIndex {
	private entries = new Map<string, IndexEntry>();
	private writing: Promise<void> = Promise.resolve();
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<void> {
		if (!existsSync(this.file)) return;
		try {
			const data = JSON.parse(await readFile(this.file, "utf8")) as IndexFile;
			if (data?.version !== 1 || !Array.isArray(data.sessions)) return;
			this.entries = new Map(data.sessions.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
		} catch {
			// A damaged index must not stop the host: sessions in the runtimes' own stores are still there.
			this.entries = new Map();
		}
	}

	list(): IndexEntry[] {
		return [...this.entries.values()];
	}

	get(id: string): IndexEntry | undefined {
		return this.entries.get(id);
	}

	upsert(entry: IndexEntry): void {
		this.entries.set(entry.id, entry);
		this.save();
	}

	patch(id: string, patch: Partial<IndexEntry>): void {
		const current = this.entries.get(id);
		if (!current) return;
		this.entries.set(id, { ...current, ...patch });
		this.save();
	}

	delete(id: string): void {
		if (this.entries.delete(id)) this.save();
	}

	/** Resolves when pending writes are on disk. */
	flush(): Promise<void> {
		return this.writing;
	}

	private save(): void {
		const body = JSON.stringify({ version: 1, sessions: this.list() } satisfies IndexFile);
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
