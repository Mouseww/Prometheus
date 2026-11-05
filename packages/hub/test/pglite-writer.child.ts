// Spawned by pglite-durability.test.ts: opens a PGlite data directory, migrates, writes one row, reports READY and then idles
// until the parent hard-kills it. Not a test file.
import { migrate } from "../src/db/migrate.ts";
import { openPglite } from "../src/db/pglite.ts";

const dir = process.argv[2];
if (!dir) throw new Error("data directory argument missing");
// A long checkpoint interval makes the test mimic the failing run: nothing is flushed before the kill except through the WAL.
const db = await openPglite(dir, { checkpointIntervalMs: 0 });
await migrate(db, { appRole: "prometheus_app" });
await db.exec("CREATE TABLE IF NOT EXISTS probe (v text)");
await db.query("INSERT INTO probe VALUES ($1)", ["written-before-kill"]);
process.stdout.write("READY\n");
setInterval(() => {}, 1000);
