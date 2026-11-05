import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TeamState } from "../types.ts";

export interface StateStore {
	/** The current state (never mutate it: `update` swaps in a new object). */
	get(): TeamState;
	/** Applies a pure change and persists the result (0600) before resolving. */
	update(change: (state: TeamState) => TeamState): Promise<TeamState>;
	/** Directory that holds `team.json` and the token file. */
	readonly dir: string;
}

const fresh = (): TeamState => ({ serverId: randomUUID(), sessions: {}, workspaces: {} });

/** Reads `<dir>/team.json` (missing or damaged files start empty) and serialises writes. */
export async function openStateStore(dir: string): Promise<StateStore> {
	const file = join(dir, "team.json");
	await mkdir(dir, { recursive: true });
	let state: TeamState = fresh();
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<TeamState>;
		state = { ...fresh(), ...parsed, sessions: parsed.sessions ?? {}, workspaces: parsed.workspaces ?? {}, serverId: parsed.serverId ?? randomUUID() };
	} catch {
		// First run or unreadable file: start empty; the next update writes a fresh one.
	}

	let writing: Promise<void> = Promise.resolve();
	const persist = (snapshot: TeamState): Promise<void> => {
		writing = writing
			.catch(() => {})
			.then(async () => {
				const tmp = `${file}.tmp`;
				await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
				await rename(tmp, file);
				await chmod(file, 0o600).catch(() => {});
			});
		return writing;
	};
	await persist(state);

	return {
		dir,
		get: () => state,
		async update(change) {
			state = change(state);
			await persist(state);
			return state;
		},
	};
}
