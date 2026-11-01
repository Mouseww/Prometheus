// The WebSocket transport the phone's rootfs browser uses, driven here with the desktop's own Chrome.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, launchBrowser, systemBrowsers } from "../src/chrome.ts";

const found = systemBrowsers()[0];

describe.skipIf(!found || process.env.PROMETHEUS_SKIP_BROWSER === "1")("browser over a debugging port", () => {
	let dir = "";
	afterAll(async () => {
		if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
	});

	it("connects through DevToolsActivePort, talks CDP and shuts down", async () => {
		dir = await mkdtemp(join(tmpdir(), "pm-browser-ws-"));
		const l = await launchBrowser({ executable: found!.path, profileDir: join(dir, "profile"), headless: true, proxy: "", lang: "en-US", window: { width: 800, height: 600 }, transport: "ws" }, dir);
		expect(l.product).toMatch(/Chrome/);
		const targets = await l.conn.send<{ targetInfos: unknown[] }>("Target.getTargets");
		expect(targets.targetInfos.length).toBeGreaterThan(0);
		await closeBrowser(l);
		expect(l.conn.closed).toBe(true);
	});
});
