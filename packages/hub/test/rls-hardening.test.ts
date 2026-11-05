import { describe, expect, it } from "vitest";
import { syncAppRoleGrants } from "../src/db/migrate.ts";
import { migratedDb } from "./helpers.ts";

const ROLE = "prometheus_app";

async function seed(db: Awaited<ReturnType<typeof migratedDb>>): Promise<void> {
	await db.exec(`
		INSERT INTO users (id, email, display_name, password_hash, status) VALUES
			('ua', 'a@a.test', 'A', 'x', 'active'), ('ub', 'b@b.test', 'B', 'x', 'active'), ('uc', 'c@c.test', 'C', 'x', 'active'),
			('uadm', 'adm@a.test', 'Adm', 'x', 'active');
		INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O1', 'o1');
		INSERT INTO org_members (org_id, user_id, role, status) VALUES ('o1', 'ua', 'member', 'active'), ('o1', 'uadm', 'admin', 'active');
		INSERT INTO teams (id, owner_user_id, name) VALUES ('tp', 'ub', 'Personal B');
		INSERT INTO team_members (team_id, user_id, role) VALUES ('tp', 'ub', 'admin');
		INSERT INTO workspaces (id, team_id, name, repo_dir) VALUES ('wp', 'tp', 'w', 'repos/wp.git');
		INSERT INTO sessions (id, workspace_id, owner_user_id) VALUES ('sp', 'wp', 'ub');
		INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, family_id) VALUES
			('r1', 'ua', 'h1', now() + interval '1 day', 'r1'), ('r2', 'ub', 'h2', now() + interval '1 day', 'r2');
		INSERT INTO invitations (id, scope, scope_id, email, role, token_hash, expires_at, created_by)
			VALUES ('i1', 'team', 'tp', 'c@c.test', 'member', 'ih1', now() + interval '1 day', 'ub');
		INSERT INTO executor_nodes (id, name, docker_url) VALUES ('n1', 'node', 'tcp://x:2376');
	`);
}

const count = async (db: Awaited<ReturnType<typeof migratedDb>>, scope: { userId: string; operator?: boolean }, sql: string): Promise<number> =>
	(await db.tx(scope, (q) => q.query(sql))).length;

describe("rls hardening", () => {
	it("keeps personal teams and everything under them to their members", async () => {
		const db = await migratedDb();
		await seed(db);
		for (const table of ["teams", "team_members", "workspaces", "sessions"]) {
			expect(await count(db, { userId: "ub" }, `SELECT 1 FROM ${table}`), `${table} member`).toBe(1);
			expect(await count(db, { userId: "ua" }, `SELECT 1 FROM ${table}`), `${table} stranger`).toBe(0);
			expect(await count(db, { userId: "ua", operator: true }, `SELECT 1 FROM ${table}`), `${table} operator`).toBe(1);
		}
		await db.close();
	});

	it("limits users to self, shared organizations and shared teams", async () => {
		const db = await migratedDb();
		await seed(db);
		const ids = async (userId: string): Promise<string[]> =>
			(await db.tx({ userId }, (q) => q.query<{ id: string }>("SELECT id FROM users ORDER BY id"))).map((r) => r.id);
		expect(await ids("ub")).toEqual(["ub"]);
		expect(await ids("ua")).toEqual(["ua", "uadm"]);
		expect(await ids("uc")).toEqual(["uc"]);
		expect((await db.tx({ userId: "uc", operator: true }, (q) => q.query("SELECT 1 FROM users"))).length).toBe(4);
		await db.close();
	});

	it("does not show unaffiliated (orphan) accounts to organization admins", async () => {
		const db = await migratedDb();
		await seed(db);
		await db.exec("INSERT INTO users (id, email, display_name, password_hash, status) VALUES ('uorph', 'pending@x.test', 'P', 'x', 'pending')");
		const ids = async (userId: string): Promise<string[]> => (await db.tx({ userId }, (q) => q.query<{ id: string }>("SELECT id FROM users ORDER BY id"))).map((r) => r.id);
		expect(await ids("uadm")).toEqual(["ua", "uadm"]);
		expect(await ids("uorph")).toEqual(["uorph"]);
		expect((await db.tx({ userId: "uadm" }, (q) => q.query("SELECT 1 FROM users WHERE id = 'uorph'"))).length).toBe(0);
		await db.close();
	});

	it("keeps refresh tokens and invitations to the people involved", async () => {
		const db = await migratedDb();
		await seed(db);
		expect(await count(db, { userId: "ua" }, "SELECT 1 FROM refresh_tokens")).toBe(1);
		expect(await count(db, { userId: "uc" }, "SELECT 1 FROM refresh_tokens")).toBe(0);
		// An organization admin may see the tokens of their members (to revoke them), not those of strangers.
		expect(await count(db, { userId: "uadm" }, "SELECT 1 FROM refresh_tokens")).toBe(1);
		// The creator and the invitee see the invitation; a third party does not.
		expect(await count(db, { userId: "ub" }, "SELECT 1 FROM invitations")).toBe(1);
		expect(await count(db, { userId: "uc" }, "SELECT 1 FROM invitations")).toBe(1);
		expect(await count(db, { userId: "ua" }, "SELECT 1 FROM invitations")).toBe(0);
		await db.close();
	});

	it("shows executor nodes to operators only", async () => {
		const db = await migratedDb();
		await seed(db);
		expect(await count(db, { userId: "ua" }, "SELECT 1 FROM executor_nodes")).toBe(0);
		expect(await count(db, { userId: "ua", operator: true }, "SELECT 1 FROM executor_nodes")).toBe(1);
		await db.close();
	});

	it("refuses the app role on tables only the Hub itself uses", async () => {
		const db = await migratedDb();
		for (const table of ["email_verifications", "password_resets", "disposable_email_domains", "tenant_credentials", "schema_migrations"]) {
			await expect(db.tx({ userId: "ua" }, (q) => q.query(`SELECT 1 FROM ${table}`)), table).rejects.toThrow(/permission denied/);
		}
		await db.close();
	});

	it("never leaves a table readable by the app role without row level security", async () => {
		const db = await migratedDb();
		// A table added later without RLS must stay ungranted, even if an earlier GRANT existed.
		await db.exec(`CREATE TABLE forgot_rls (id text PRIMARY KEY); GRANT SELECT ON forgot_rls TO ${ROLE};`);
		await syncAppRoleGrants(db, ROLE);
		const rows = await db.query<{ name: string; rls: boolean; readable: boolean }>(
			`SELECT c.relname AS name, c.relrowsecurity AS rls, has_table_privilege('${ROLE}', c.oid, 'SELECT') AS readable
			 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
		);
		expect(rows.length).toBeGreaterThan(20);
		expect(rows.filter((r) => r.readable && !r.rls).map((r) => r.name)).toEqual([]);
		expect(rows.find((r) => r.name === "forgot_rls")?.readable).toBe(false);
		await db.close();
	});
});
