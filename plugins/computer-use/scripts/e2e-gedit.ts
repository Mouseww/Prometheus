// Linux end-to-end check: gedit through the AT-SPI driver, no screenshots.
// Run inside a session that has a display and an accessibility bus (see .github/workflows/computer-use-linux.yml).
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
	await step("launch gedit", () => svc.launch(S, "gedit", undefined));
	const out = await step("observe", () => svc.observe(S, "gedit", { maxTokens: 3000 }));
	const doc = refOf(out, /\] document /);
	const a = await step("set_value", () => svc.act(S, undefined, "gedit", [{ ref: doc, op: "set_value", value: "Hello from Prometheus Computer Use\n你好，世界" }]));
	const b = await step("type", () => svc.act(S, undefined, "gedit", [{ ref: doc, op: "type", value: " (typed)" }]));
	const back = await svc.observe(S, "gedit", { query: "Hello" });
	console.log(`\n===== read back =====\n${back}`);
	const pass = /你好，世界/.test(a + back) && /typed/.test(b + back);
	console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
	if (!pass) process.exitCode = 1;
} finally {
	driver.close();
}
