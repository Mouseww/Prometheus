// Render docs/promo/*-WxH.html posters to PNG (docs/promo/out/).
//   node scripts/promo/render.mjs
import { mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(`${process.env.APPDATA}/npm/node_modules/`);
const { chromium } = require("playwright");
const dir = resolve(fileURLToPath(new URL("../../docs/promo", import.meta.url)));
const out = join(dir, "out");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
for (const f of readdirSync(dir).filter((f) => /-\d+x\d+\.html$/.test(f))) {
	const [, w, h] = f.match(/-(\d+)x(\d+)\.html$/);
	const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
	await page.goto(pathToFileURL(join(dir, f)).href, { waitUntil: "networkidle" });
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: join(out, f.replace(".html", ".png")) });
	console.log("rendered", f);
	await page.close();
}
await browser.close();
