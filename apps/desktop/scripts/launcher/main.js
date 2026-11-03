// Entry of the desktop server bundle. The installer carries neither the PI agent (@earendil-works/*, an optional agent engine
// like Claude Code or Codex; the desktop shell installs it and sets PROMETHEUS_PI_DIR) nor the big optional packages (LanceDB, the
// Claude Agent SDK; the server installs them into <home>/packages on demand). This launcher lets the server import them from
// those folders. The server itself is ./app.js.
import { existsSync } from "node:fs";
import { register } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.PROMETHEUS_HOME || join(homedir(), ".prometheus");
const piDir = process.env.PROMETHEUS_PI_DIR || join(home, "pi-agent");
const piMarker = join(piDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");

register("./pi-hooks.mjs", {
	parentURL: import.meta.url,
	data: { packagesDir: join(home, "packages"), piParent: existsSync(piMarker) ? pathToFileURL(join(piDir, "index.js")).href : undefined },
});

// The server treats the PI agent as optional: without it only the other agent runtimes are available.
await import("./app.js");
