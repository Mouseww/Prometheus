// Android end-to-end check over adb (emulator or a USB-debugging phone), no screenshots:
//   node --experimental-strip-types plugins/computer-use/scripts/e2e-android.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit.ts";
import { ComputerService, DEFAULT_SETTINGS } from "../src/computer.ts";
import { Decider } from "../src/decider.ts";
import { AdbDriver } from "../src/driver/adb.ts";

const driver = await AdbDriver.connect(process.env.ADB ?? "adb", process.env.ANDROID_SERIAL);
console.log("hello:", JSON.stringify(driver.hello));
const dir = mkdtempSync(join(tmpdir(), "cu-e2e-"));
const svc = new ComputerService({
	driver: async () => driver,
	settings: () => ({ ...DEFAULT_SETTINGS, device: "adb", settleMs: 700, settleTimeoutMs: 4000 }),
	decider: new Decider(() => ({ kind: "off" }), () => []),
	audit: new AuditLog(join(dir, "audit.jsonl")),
	selfPids: new Set(),
	device: () => "android",
});
const S = "e2e";
const step = async (label: string, fn: () => Promise<string>) => {
	const t = Date.now();
	const out = await fn();
	console.log(`\n===== ${label} (${Date.now() - t} ms) =====\n${out}`);
	return out;
};

try {
	await step("windows", () => svc.apps());
	await step("launch settings", () => svc.launch(S, "com.android.settings", undefined));
	await new Promise((r) => setTimeout(r, 2000));
	const obs = await step("observe", () => svc.observe(S, "screen", {}));
	// Click the settings row whose label is "Network & internet": the nearest enclosing element that has the click action.
	const lines = obs.split("\n");
	const at = lines.findIndex((l) => /text "Network & internet"/.test(l));
	const indent = (l: string) => l.length - l.trimStart().length;
	let line: string | undefined;
	for (let i = at - 1; at >= 0 && i >= 0; i--) {
		if (indent(lines[i]!) < indent(lines[at]!) && /\{[^}]*click/.test(lines[i]!)) {
			line = lines[i];
			break;
		}
	}
	const ref = line?.match(/\[(e\d+)\]/)?.[1];
	console.log("clicking:", line);
	let pass = obs.split("\n").length > 5;
	if (ref) {
		const out = await step("click", () => svc.act(S, undefined, "screen", [{ ref, op: "click" }]));
		pass = pass && out.includes("✓ click") && !/没有可见变化/.test(out);
	}
	const back = await step("keys back", () => svc.keys(S, undefined, "screen", "back", undefined));
	pass = pass && back.includes("✓");
	console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
	if (!pass) process.exitCode = 1;
} finally {
	driver.close();
}
