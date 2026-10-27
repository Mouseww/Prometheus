// macOS end-to-end check: TextEdit via the AX driver, no screenshots.
//   node --experimental-strip-types plugins/computer-use/scripts/e2e-textedit.ts
// Set PROMETHEUS_CU_DRIVER to a prebuilt driver binary to skip compiling.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit.ts";
import { ComputerService, DEFAULT_SETTINGS } from "../src/computer.ts";
import { Decider } from "../src/decider.ts";
import { startLocalDriver } from "../src/driver/local.ts";

const dir = mkdtempSync(join(tmpdir(), "cu-e2e-"));
const driver = await startLocalDriver(join(dir, "data"), console.error);
console.log("hello:", JSON.stringify(driver.hello));
if (driver.hello.permissions.accessibility !== "granted") {
	console.log("RESULT: SKIPPED (Accessibility not granted to this process; driver handshake and compile are fine)");
	driver.close();
	process.exit(0);
}
const svc = new ComputerService({
	driver: async () => driver,
	settings: () => DEFAULT_SETTINGS,
	decider: new Decider(() => ({ kind: "off" }), () => []),
	audit: new AuditLog(join(dir, "audit.jsonl")),
	selfPids: new Set([process.pid]),
});
const S = "e2e";
const step = async (label: string, fn: () => Promise<string>) => {
	const t = Date.now();
	const out = await fn();
	console.log(`\n===== ${label} (${Date.now() - t} ms) =====\n${out}`);
	return out;
};
const refOf = (out: string, re: RegExp) => {
	const m = out.split("\n").find((l) => re.test(l))?.match(/\[([a-z]\d+)\]/);
	if (!m) throw new Error(`no element matching ${re}`);
	return m[1]!;
};

try {
	await step("windows", () => svc.apps());
	let out = await step("launch TextEdit", () => svc.launch(S, "TextEdit", undefined));
	if (!/document /.test(out)) {
		// Fresh TextEdit shows an Open panel first: ask for a new document.
		await step("cmd+n", () => svc.keys(S, undefined, "TextEdit", "cmd+n", undefined));
		out = await step("observe", () => svc.observe(S, "TextEdit", {}));
	}
	const doc = refOf(out, /\] document /);
	const act = await step("set_value", () => svc.act(S, undefined, "TextEdit", [{ ref: doc, op: "set_value", value: "Hello from Prometheus Computer Use\n你好，世界" }]));
	const typed = await step("type", () => svc.act(S, undefined, "TextEdit", [{ ref: doc, op: "type", value: " (typed)" }]));
	const after = await svc.observe(S, "TextEdit", { query: "Hello" });
	console.log(`\n===== read back =====\n${after}`);
	const pass = /你好，世界/.test(act + after) && /typed/.test(typed + after);
	await step("quit (cmd+q, discard)", () => svc.keys(S, undefined, "TextEdit", "cmd+q", undefined).catch((e) => String(e)));
	console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
	if (!pass) process.exitCode = 1;
} finally {
	driver.close();
}
