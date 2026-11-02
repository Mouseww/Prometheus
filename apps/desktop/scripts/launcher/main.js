// Entry of the desktop server bundle. The installer does not carry the PI agent packages (@earendil-works/*): the app
// installs them on first use into its own folder (PROMETHEUS_PI_DIR, set by the desktop shell), and this launcher lets the
// server import them from there before it loads. Nothing else happens here; the server itself is ./app.js.
import { existsSync } from "node:fs";
import { register } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.PROMETHEUS_HOME || join(homedir(), ".prometheus");
const piDir = process.env.PROMETHEUS_PI_DIR || join(home, "pi-agent");
const piMarker = join(piDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");

if (existsSync(piMarker)) {
	register("./pi-hooks.mjs", { parentURL: import.meta.url, data: { parent: pathToFileURL(join(piDir, "index.js")).href } });
}

try {
	await import("./app.js");
} catch (err) {
	if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes("@earendil-works/")) {
		console.error(`The PI agent is not installed (looked in ${piDir}). Install it from Prometheus (Settings -> Runtimes), or run: npm install --prefix "${piDir}" ${process.env.PROMETHEUS_PI_PACKAGES ?? "@earendil-works/pi-coding-agent"}`);
		process.exit(78);
	}
	throw err;
}
