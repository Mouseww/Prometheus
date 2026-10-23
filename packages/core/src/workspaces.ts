import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createJsonStore, type JsonStore } from "@prometheus/plugin-sdk";
import { AppError, type WorkspaceInfo } from "@prometheus/protocol";

interface WorkspaceFile {
	workspaces: WorkspaceInfo[];
	/** Paths the user removed; sessions found there no longer recreate the workspace. */
	hidden: string[];
	archived: string[];
}

export function normalizeDir(path: string): string {
	const abs = resolve(path).replace(/[\\/]+$/, "");
	// Keep drive roots like "C:\" intact after stripping trailing separators.
	return /^[A-Za-z]:$/.test(abs) ? `${abs}\\` : abs || "/";
}

/** Stable id per directory; case-insensitive on Windows so `C:\Foo` and `c:\foo` share a workspace. */
export function workspaceId(path: string): string {
	const key = process.platform === "win32" ? normalizeDir(path).toLowerCase() : normalizeDir(path);
	return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

export class WorkspaceStore {
	private readonly store: JsonStore<WorkspaceFile>;
	private cache: WorkspaceFile | undefined;

	constructor(file: string) {
		this.store = createJsonStore<WorkspaceFile>(file, () => ({ workspaces: [], hidden: [], archived: [] }));
	}

	private async data(): Promise<WorkspaceFile> {
		if (!this.cache) {
			const raw = await this.store.read();
			this.cache = { workspaces: raw.workspaces ?? [], hidden: raw.hidden ?? [], archived: raw.archived ?? [] };
		}
		return this.cache;
	}

	private async write(fn: (d: WorkspaceFile) => void): Promise<WorkspaceFile> {
		await this.data();
		this.cache = await this.store.update((current) => {
			const next: WorkspaceFile = { workspaces: current.workspaces ?? [], hidden: current.hidden ?? [], archived: current.archived ?? [] };
			fn(next);
			return next;
		});
		return this.cache;
	}

	async list(): Promise<WorkspaceInfo[]> {
		return [...(await this.data()).workspaces].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
	}

	async archived(): Promise<Set<string>> {
		return new Set((await this.data()).archived);
	}

	/** Explicit add (or reuse): validates the directory and un-hides it. */
	async add(path: string, name?: string): Promise<WorkspaceInfo> {
		const dir = normalizeDir(path);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new AppError("dirNotFound", { dir });
		const id = workspaceId(dir);
		const now = new Date().toISOString();
		let result: WorkspaceInfo | undefined;
		await this.write((d) => {
			d.hidden = d.hidden.filter((h) => h !== id);
			const existing = d.workspaces.find((w) => w.id === id);
			if (existing) {
				existing.lastUsedAt = now;
				if (name?.trim()) existing.name = name.trim();
				result = existing;
			} else {
				result = { id, path: dir, name: name?.trim() || basename(dir) || dir, createdAt: now, lastUsedAt: now };
				d.workspaces.push(result);
			}
		});
		return result as WorkspaceInfo;
	}

	/** Registers directories discovered from existing sessions, skipping ones the user removed. */
	async ensure(entries: { path: string; modified: string }[]): Promise<void> {
		const d = await this.data();
		const known = new Set([...d.workspaces.map((w) => w.id), ...d.hidden]);
		const missing = new Map<string, { path: string; modified: string }>();
		for (const e of entries) {
			if (!e.path) continue;
			const id = workspaceId(e.path);
			if (known.has(id)) continue;
			const prev = missing.get(id);
			if (!prev || prev.modified < e.modified) missing.set(id, e);
		}
		if (!missing.size) return;
		await this.write((next) => {
			for (const [id, e] of missing) {
				if (next.workspaces.some((w) => w.id === id) || next.hidden.includes(id)) continue;
				const dir = normalizeDir(e.path);
				next.workspaces.push({ id, path: dir, name: basename(dir) || dir, createdAt: e.modified, lastUsedAt: e.modified });
			}
		});
	}

	async touch(id: string): Promise<void> {
		const now = new Date().toISOString();
		await this.write((d) => {
			const w = d.workspaces.find((x) => x.id === id);
			if (w) w.lastUsedAt = now;
		});
	}

	async rename(id: string, name: string): Promise<WorkspaceInfo> {
		if (!name.trim()) throw new AppError("folderNameEmpty");
		let result: WorkspaceInfo | undefined;
		await this.write((d) => {
			result = d.workspaces.find((w) => w.id === id);
			if (result) result.name = name.trim();
		});
		if (!result) throw new AppError("workspaceNotFound", { id });
		return result;
	}

	/** Removes the workspace from the list only; its sessions stay on disk. */
	async remove(id: string): Promise<void> {
		await this.write((d) => {
			d.workspaces = d.workspaces.filter((w) => w.id !== id);
			if (!d.hidden.includes(id)) d.hidden.push(id);
		});
	}

	async setArchived(sessionId: string, archived: boolean): Promise<void> {
		await this.write((d) => {
			d.archived = d.archived.filter((s) => s !== sessionId);
			if (archived) d.archived.push(sessionId);
		});
	}
}
