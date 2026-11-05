// The note a plugin pinned to a session (ctx.sessions.setBadge). Kept apart from the session index so it covers every
// runtime. Written the same way as OwnerStore: queued, temp file then rename.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionBadge } from "@prometheus/protocol";

interface BadgesFile {
	version: 1;
	badges: Record<string, SessionBadge>;
}

const TEXT_LIMIT = 120;

function valid(value: unknown): value is SessionBadge {
	if (typeof value !== "object" || value === null) return false;
	const b = value as Partial<SessionBadge>;
	return typeof b.text === "string" && b.text.length > 0 && (b.tone === "info" || b.tone === "warn");
}

export class BadgeStore {
	private badges = new Map<string, SessionBadge>();
	private writing: Promise<void> = Promise.resolve();
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<void> {
		if (!existsSync(this.file)) return;
		try {
			const data = JSON.parse(await readFile(this.file, "utf8")) as Partial<BadgesFile>;
			const badges = data.badges && typeof data.badges === "object" ? data.badges : {};
			this.badges = new Map(Object.entries(badges).filter((e): e is [string, SessionBadge] => valid(e[1])));
		} catch {
			this.badges = new Map();
		}
	}

	get(id: string): SessionBadge | undefined {
		return this.badges.get(id);
	}

	/** Returns whether anything changed. `undefined` clears the badge. */
	set(id: string, badge: SessionBadge | undefined): boolean {
		if (badge === undefined) {
			if (!this.badges.delete(id)) return false;
			this.save();
			return true;
		}
		const next: SessionBadge = { text: String(badge.text).trim().slice(0, TEXT_LIMIT), tone: badge.tone === "warn" ? "warn" : "info" };
		if (!next.text) return this.set(id, undefined);
		const current = this.badges.get(id);
		if (current && current.text === next.text && current.tone === next.tone) return false;
		this.badges.set(id, next);
		this.save();
		return true;
	}

	delete(id: string): void {
		if (this.badges.delete(id)) this.save();
	}

	flush(): Promise<void> {
		return this.writing;
	}

	private save(): void {
		const body = JSON.stringify({ version: 1, badges: Object.fromEntries(this.badges) } satisfies BadgesFile);
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
