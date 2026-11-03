// Module resolution hooks (loaded through module.register by main.js). The installer carries neither the PI agent
// (@earendil-works/*) nor the big optional packages (LanceDB, the Claude Agent SDK): they are installed later into
// folders of their own. When a bare import cannot be resolved the normal way it is retried from each of those folders,
// so a package installed while the server runs is found without a restart. The packages' own dependencies resolve from
// where they sit, as usual.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let packagesDir;
let piParent;

export function initialize(data) {
	packagesDir = data?.packagesDir;
	piParent = data?.piParent;
}

const isBare = (s) => !s.startsWith(".") && !s.startsWith("/") && !s.startsWith("file:") && !s.startsWith("node:") && !s.startsWith("data:") && !/^[A-Za-z]:[\/]/.test(s);

function parents() {
	const out = [];
	if (piParent) out.push(piParent);
	try {
		for (const e of readdirSync(packagesDir, { withFileTypes: true })) {
			if (e.isDirectory() && existsSync(join(packagesDir, e.name, "node_modules"))) out.push(pathToFileURL(join(packagesDir, e.name, "index.js")).href);
		}
	} catch {
		// No folder yet: nothing is installed.
	}
	return out;
}

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		if (isBare(specifier) && (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) {
			for (const parentURL of parents()) {
				try {
					return await nextResolve(specifier, { ...context, parentURL });
				} catch {
					// Not in this folder; try the next, then report the original failure: it names what the importer asked for.
				}
			}
		}
		throw err;
	}
}
