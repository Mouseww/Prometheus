import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultMigrationsDir, migrate } from "../src/db/migrate.ts";
import { openPglite } from "../src/db/pglite.ts";
import { ulid } from "../src/ids.ts";
import { migratedDb } from "./helpers.ts";

describe("pglite driver", () => {
	it("supports roles, SET LOCAL ROLE and RLS", async () => {
		const db = await openPglite("memory");
		await db.exec(`
			CREATE ROLE probe_r NOLOGIN;
			CREATE TABLE t (id text PRIMARY KEY, org_id text);
			GRANT SELECT, INSERT ON t TO probe_r;
			GRANT probe_r TO CURRENT_USER;
			ALTER TABLE t ENABLE ROW LEVEL SECURITY;
			CREATE POLICY p ON t USING (org_id = current_setting('app.org', true));
			INSERT INTO t VALUES ('1','a'),('2','b');
		`);
		const visible = await db.tx({ system: true }, async (q) => {
			await q.exec("SET LOCAL ROLE probe_r");
			await q.query("SELECT set_config('app.org', 'a', true)");
			return q.query<{ id: string }>("SELECT id FROM t");
		});
		expect(visible.map((r) => r.id)).toEqual(["1"]);
		expect(await db.query("SELECT id FROM t")).toHaveLength(2);
		await db.close();
	});
});

describe("migrations", () => {
	it("is idempotent", async () => {
		const db = await migratedDb();
		expect(await migrate(db, { appRole: "prometheus_app" })).toEqual([]);
		const rows = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
		// Later blocks add 002_git ... 007_public and more; every one is recorded exactly once (names are unique, so the sorted list has no repeats).
		const versions = rows.map((r) => r.version).sort();
		expect(versions).toEqual(expect.arrayContaining(["001_core", "002_git", "003_sessions", "004_models", "005_runtime", "006_billing", "007_public"]));
		expect(new Set(versions).size).toBe(versions.length);
		const policy = await db.query<{ scope: string; closed: boolean; require_approval: boolean }>("SELECT * FROM registration_policies");
		expect(policy).toHaveLength(1);
		expect(policy[0]).toMatchObject({ scope: "platform", closed: false, require_approval: true });
		await db.close();
	});

	it("picks up files added later, in name order", async () => {
		const db = await migratedDb();
		const dir = await mkdtemp(join(tmpdir(), "hub-mig-"));
		await writeFile(join(dir, "003_b.sql"), "CREATE TABLE later_b (id text PRIMARY KEY);");
		await writeFile(
			join(dir, "002_a.sql"),
			"CREATE TABLE later_a (id text PRIMARY KEY); INSERT INTO later_a VALUES ('x'); ALTER TABLE later_a ENABLE ROW LEVEL SECURITY; CREATE POLICY open ON later_a USING (true);",
		);
		const applied = await migrate(db, { appRole: "prometheus_app", dir });
		expect(applied).toEqual(["002_a", "003_b"]);
		// A later table with RLS is granted to the app role without extra GRANTs; one without RLS stays out of its reach.
		const rows = await db.tx({ userId: "nobody" }, (q) => q.query("SELECT * FROM later_a"));
		expect(rows).toHaveLength(1);
		await expect(db.tx({ userId: "nobody" }, (q) => q.query("SELECT * FROM later_b"))).rejects.toThrow(/permission denied/);
		await db.close();
	});

	it("uses a custom app role", async () => {
		const db = await openPglite("memory", { appRole: "hub_custom" });
		await migrate(db, { appRole: "hub_custom" });
		const rows = await db.tx({ userId: "u" }, (q) => q.query<{ r: string }>("SELECT current_user AS r"));
		expect(rows[0]?.r).toBe("hub_custom");
		await db.close();
	});

	it("prints the DBA SQL when the app role cannot be created", async () => {
		const real = await openPglite("memory");
		const denied = {
			...real,
			query: async (text: string, params?: unknown[]) => {
				if (text.startsWith("CREATE ROLE")) throw new Error("permission denied to create role");
				return real.query(text, params);
			},
		} as typeof real;
		const err = await migrate(denied, { appRole: "hub_app" }).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;
		expect(message).toContain("permission denied to create role");
		expect(message).toContain("CREATE ROLE hub_app NOLOGIN;");
		expect(message).toContain("GRANT hub_app TO");
		// Nothing was migrated: RLS is never silently skipped.
		expect(await real.query("SELECT to_regclass('public.users') AS t")).toEqual([{ t: null }]);
		await real.close();
	});

	it("rejects an invalid role name", async () => {
		const db = await openPglite("memory");
		await expect(migrate(db, { appRole: "bad role; drop" })).rejects.toThrow(/角色名无效/);
		await db.close();
	});
});

describe("row level security", () => {
	it("isolates organizations through tx({userId})", async () => {
		const db = await migratedDb();
		const [uA, uB, uOp] = [ulid(), ulid(), ulid()];
		const [orgA, orgB] = [ulid(), ulid()];
		await db.exec(`
			INSERT INTO users (id, email, display_name, password_hash, status) VALUES
				('${uA}', 'a@a.test', 'A', 'x', 'active'), ('${uB}', 'b@b.test', 'B', 'x', 'active'), ('${uOp}', 'op@x.test', 'Op', 'x', 'active');
			INSERT INTO organizations (id, name, slug) VALUES ('${orgA}', 'Org A', 'org-a'), ('${orgB}', 'Org B', 'org-b');
			INSERT INTO org_members (org_id, user_id, role, status) VALUES ('${orgA}', '${uA}', 'owner', 'active'), ('${orgB}', '${uB}', 'owner', 'active');
			INSERT INTO teams (id, org_id, name) VALUES ('ta', '${orgA}', 'Team A'), ('tb', '${orgB}', 'Team B');
			INSERT INTO teams (id, owner_user_id, name) VALUES ('tp', '${uB}', 'Personal B');
			INSERT INTO team_members (team_id, user_id, role, org_id) VALUES ('ta', '${uA}', 'admin', '${orgA}'), ('tb', '${uB}', 'admin', '${orgB}');
			INSERT INTO audit_log (id, org_id, action) VALUES ('al1', '${orgA}', 'x'), ('al2', '${orgB}', 'x');
		`);

		const teamsA = await db.tx({ userId: uA }, (q) => q.query<{ id: string }>("SELECT id FROM teams ORDER BY id"));
		// Personal teams (org_id null) belong to their members: B's personal team is not visible to A.
		expect(teamsA.map((t) => t.id)).toEqual(["ta"]);
		expect((await db.tx({ userId: uA }, (q) => q.query("SELECT 1 FROM organizations"))).length).toBe(1);
		expect((await db.tx({ userId: uA }, (q) => q.query("SELECT 1 FROM org_members"))).length).toBe(1);
		expect((await db.tx({ userId: uA }, (q) => q.query("SELECT 1 FROM team_members"))).length).toBe(1);
		expect((await db.tx({ userId: uA }, (q) => q.query("SELECT 1 FROM audit_log"))).length).toBe(1);
		expect((await db.tx({ userId: uB }, (q) => q.query("SELECT 1 FROM audit_log WHERE org_id = $1", [orgA]))).length).toBe(0);

		// Writes into another organization are rejected by the policy.
		await expect(
			db.tx({ userId: uA }, (q) => q.query("INSERT INTO teams (id, org_id, name) VALUES ('evil', $1, 'x')", [orgB])),
		).rejects.toThrow(/row-level security/);

		// A user outside every organization sees none of them; an operator sees all of them.
		expect((await db.tx({ userId: uOp }, (q) => q.query("SELECT 1 FROM organizations"))).length).toBe(0);
		expect((await db.tx({ userId: uOp, operator: true }, (q) => q.query("SELECT 1 FROM organizations"))).length).toBe(2);
		// The system scope bypasses RLS.
		expect((await db.tx({ system: true }, (q) => q.query("SELECT 1 FROM organizations"))).length).toBe(2);
		await db.close();
	});

	it("pending members do not grant visibility", async () => {
		const db = await migratedDb();
		await db.exec(`
			INSERT INTO users (id, email, display_name, password_hash, status) VALUES ('u1', 'u1@a.test', 'U', 'x', 'pending');
			INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o');
			INSERT INTO org_members (org_id, user_id, role, status) VALUES ('o1', 'u1', 'member', 'pending');
			INSERT INTO teams (id, org_id, name) VALUES ('t1', 'o1', 'T');
		`);
		expect(await db.tx({ userId: "u1" }, (q) => q.query("SELECT 1 FROM teams WHERE org_id IS NOT NULL"))).toHaveLength(0);
		await db.close();
	});
});

describe("ulid", () => {
	it("is 26 chars and monotonic", () => {
		const ids = Array.from({ length: 200 }, () => ulid());
		expect(ids.every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i))).toBe(true);
		expect([...ids].sort()).toEqual(ids);
		expect(new Set(ids).size).toBe(200);
	});
});

/** Opt-in: set HUB_TEST_DATABASE_URL to a disposable PostgreSQL database to run the same checks against postgres.js. */
describe.skipIf(!process.env.HUB_TEST_DATABASE_URL)("postgres driver", () => {
	it("migrates and enforces RLS", async () => {
		const { openPostgres } = await import("../src/db/postgres.ts");
		const db = openPostgres(process.env.HUB_TEST_DATABASE_URL as string);
		await migrate(db, { appRole: "prometheus_app" });
		const rows = await db.tx({ userId: "nobody" }, (q) => q.query("SELECT 1 FROM organizations"));
		expect(rows).toHaveLength(0);
		await db.close();
	});
});
