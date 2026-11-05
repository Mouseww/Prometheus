import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { openPglite } from "../src/db/pglite.ts";

export async function migratedDb(): Promise<Db> {
	const db = await openPglite("memory");
	await migrate(db, { appRole: "prometheus_app" });
	return db;
}

export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "hub-test-"));
