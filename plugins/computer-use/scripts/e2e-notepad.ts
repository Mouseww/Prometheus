// Manual end-to-end check on Windows (M0 acceptance): launch Notepad, write text, save it through the
// Save dialog, verify the file, close Notepad. No screenshots are taken at any point.
//   node --experimental-strip-types plugins/computer-use/scripts/e2e-notepad.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit.ts";
import { ComputerService, DEFAULT_SETTINGS } from "../src/computer.ts";
import { Decider } from "../src/decider.ts";
import { startLocalDriver } from "../src/driver/local.ts";

const dir = mkdtempSync(join(tmpdir(), "cu-e2e-"));
const file = join(dir, "hello.txt");
const driver = await startLocalDriver(join(dir, "data"), console.error);
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
	const line = out.split("\n").find((l) => re.test(l));
	const m = line?.match(/\[([a-z]\d+)\]/);
	if (!m) throw new Error(`no element matching ${re}`);
	return m[1]!;
};

try {
	const launched = await step("launch notepad", () => svc.launch(S, "notepad.exe", undefined));
	const doc = refOf(launched, /\] (document|textbox) /);
	await step("set_value", () => svc.act(S, undefined, undefined, [{ ref: doc, op: "set_value", value: "Hello from Prometheus Computer Use\n你好，世界" }]));
	const saveDlg = await step("ctrl+s", () => svc.keys(S, undefined, undefined, "ctrl+s", undefined));
	// The Save dialog is its own window; find its file-name box and the Save button there.
	const dlgId = saveDlg.match(/新窗口：窗口 \[(\d+)\]/)?.[1] ?? "另存为";
	const found = await step("find file name box", () => svc.find(S, undefined, dlgId, "文件名 File name", "combobox"));
	const nameBox = await step("observe file name box", () => svc.observe(S, dlgId, { query: "文件名 File name" }));
	const edit = (() => {
		try {
			return refOf(nameBox, /\] textbox "(文件名|File name)/);
		} catch {
			return refOf(found, /\] (textbox|combobox) /);
		}
	})();
	const save = refOf(await svc.observe(S, dlgId, { query: "保存 Save" }), /\] button "(保存|Save)/);
	await step("type path and save", () => svc.act(S, undefined, dlgId, [{ ref: edit, op: "set_value", value: file }, { ref: save, op: "click" }]));
	await new Promise((r) => setTimeout(r, 500));
	const saved = existsSync(file) ? readFileSync(file, "utf8") : "(missing)";
	console.log(`\n===== file content =====\n${saved}`);
	await step("close", () => svc.keys(S, undefined, "hello.txt", "alt+f4", undefined));
	console.log(`\nRESULT: ${saved.includes("你好，世界") ? "PASS" : "FAIL"}`);
} finally {
	driver.close();
}
