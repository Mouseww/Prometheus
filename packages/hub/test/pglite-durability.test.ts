import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.ts";
import { openPglite } from "../src/db/pglite.ts";
import { ALLOW_RESET_ENV } from "../src/db/pglite-guard.ts";
import { silentLog } from "../src/log.ts";
import { closeOnSignals } from "../src/shutdown.ts";
import { tempDir } from "./helpers.ts";

const APP_ROLE = "prometheus_app";
const CHILD = fileURLToPath(new URL("./pglite-writer.child.ts", import.meta.url));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function migrated(dir: string, opts: { env?: NodeJS.ProcessEnv } = {}) {
	const db = await openPglite(dir, { checkpointIntervalMs: 0, ...opts });
	await migrate(db, { appRole: APP_ROLE });
	return db;
}

describe("PGlite durability", () => {
	it("keeps rows and the migrations table across a clean close", async () => {
		const dir = join(await tempDir(), "pgdata");
		const a = await migrated(dir);
		await a.exec("CREATE TABLE probe (v text)");
		await a.query("INSERT INTO probe VALUES ('x')");
		await a.close();
		const b = await migrated(dir);
		expect(await b.query("SELECT v FROM probe")).toEqual([{ v: "x" }]);
		expect(await migrate(b, { appRole: APP_ROLE })).toEqual([]);
		await b.close();
	});

	it("survives a hard kill of the writer process (WAL replay) without re-running migrations", async () => {
		const dir = join(await tempDir(), "pgdata");
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, dir], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (d: Buffer) => (out += d.toString()));
		child.stderr.on("data", (d: Buffer) => (err += d.toString()));
		const exited = new Promise<void>((r) => child.once("exit", () => r()));
		for (let i = 0; i < 300 && !out.includes("READY") && child.exitCode === null; i++) await wait(100);
		expect(out, err).toContain("READY");
		child.kill("SIGKILL");
		await exited;

		const db = await migrated(dir);
		const probe = await db.query<{ v: string }>("SELECT v FROM probe");
		const applied = await db.query<{ n: string }>("SELECT count(*) AS n FROM schema_migrations");
		await db.close();
		expect(probe).toEqual([{ v: "written-before-kill" }]);
		expect(Number(applied[0]?.n)).toBeGreaterThanOrEqual(14);
	}, 60_000);

	it("checkpoints periodically so data reaches the data files without a clean close", async () => {
		const dir = join(await tempDir(), "pgdata");
		const db = await openPglite(dir, { checkpointIntervalMs: 150 });
		const control = join(dir, "global", "pg_control");
		const before = (await stat(control)).mtimeMs;
		await db.exec("CREATE TABLE probe (v text)");
		let after = before;
		for (let i = 0; i < 60 && after === before; i++) {
			await wait(100);
			after = (await stat(control)).mtimeMs;
		}
		await db.close();
		expect(after).toBeGreaterThan(before);
	});
});

describe("PGlite data directory lock", () => {
	it("refuses a second open of the same directory and allows it after close", async () => {
		const dir = join(await tempDir(), "pgdata");
		const a = await openPglite(dir, { checkpointIntervalMs: 0 });
		await expect(openPglite(dir, { checkpointIntervalMs: 0 })).rejects.toThrow(/已被本进程/);
		await a.close();
		await (await openPglite(dir, { checkpointIntervalMs: 0 })).close();
	});

	it("names the owner pid when another live process holds the lock", async () => {
		const dir = join(await tempDir(), "pgdata");
		await mkdir(join(dir, ".."), { recursive: true });
		await writeFile(`${dir}.lock`, String(process.ppid));
		await expect(openPglite(dir, { checkpointIntervalMs: 0 })).rejects.toThrow(new RegExp(`进程 ${process.ppid} 使用`));
	});

	it("takes over a lock left by a dead process", async () => {
		const dir = join(await tempDir(), "pgdata");
		await writeFile(`${dir}.lock`, "2147483646");
		await (await openPglite(dir, { checkpointIntervalMs: 0 })).close();
	});
});

describe("lost bookkeeping guard", () => {
	/** An initialised cluster whose catalogs forgot their tables while table files remain: the observed data loss state. */
	async function clusterWithOrphans(): Promise<string> {
		const dir = join(await tempDir(), "pgdata");
		await (await openPglite(dir, { checkpointIntervalMs: 0 })).close();
		const base = join(dir, "base");
		const dbDir = (await readdir(base)).sort().at(-1) as string;
		await writeFile(join(base, dbDir, "16385"), Buffer.alloc(8192, 1));
		return dir;
	}

	it("refuses to initialise over orphaned table files and leaves them untouched", async () => {
		const dir = await clusterWithOrphans();
		await expect(openPglite(dir, { checkpointIntervalMs: 0, env: {} })).rejects.toThrow(/拒绝启动/);
		// The lock is released on refusal, so the operator can fix it and retry.
		await openPglite(dir, { checkpointIntervalMs: 0, env: { [ALLOW_RESET_ENV]: "1" } }).then((d) => d.close());
	});

	it("allows an initialised but never migrated directory (nothing to lose)", async () => {
		const dir = join(await tempDir(), "pgdata");
		await (await openPglite(dir, { checkpointIntervalMs: 0 })).close();
		const db = await migrated(dir, { env: {} });
		expect((await db.query<{ n: string }>("SELECT count(*) AS n FROM schema_migrations"))[0]?.n).toBeDefined();
		await db.close();
	});

	it("does not trigger on a normally migrated directory", async () => {
		const dir = join(await tempDir(), "pgdata");
		await (await migrated(dir)).close();
		await (await migrated(dir, { env: {} })).close();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("closeOnSignals", () => {
	it("closes the hub once on a stop signal and then exits 0", async () => {
		let closed = 0;
		const exits: number[] = [];
		const off = closeOnSignals(
			{ close: async () => void closed++ },
			{ log: silentLog, exit: (c) => void exits.push(c), signals: ["SIGUSR2"] },
		);
		process.emit("SIGUSR2", "SIGUSR2");
		process.emit("SIGUSR2", "SIGUSR2");
		await wait(50);
		off();
		expect(closed).toBe(1);
		expect(exits).toEqual([0]);
	});

	it("exits 1 when close fails", async () => {
		const exits: number[] = [];
		const off = closeOnSignals(
			{ close: async () => Promise.reject(new Error("boom")) },
			{ log: silentLog, exit: (c) => void exits.push(c), signals: ["SIGUSR2"] },
		);
		process.emit("SIGUSR2", "SIGUSR2");
		await wait(50);
		off();
		expect(exits).toEqual([1]);
	});
});
