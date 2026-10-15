import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackageKind } from "@prometheus/protocol";

const KINDS: PackageKind[] = ["extensions", "skills", "prompts", "themes"];

export interface PackageManifest {
	name?: string;
	version?: string;
	description?: string;
	kinds: PackageKind[];
}

/** What an installed package contributes: its `pi` manifest if present, otherwise PI's conventional directories. */
export function readManifest(root: string): PackageManifest {
	let pkg: { name?: unknown; version?: unknown; description?: unknown; pi?: Record<string, unknown> } = {};
	try {
		pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as typeof pkg;
	} catch {
		// Git or local packages may have no package.json.
	}
	const declared = pkg.pi && typeof pkg.pi === "object" ? pkg.pi : undefined;
	const kinds = KINDS.filter((k) => {
		const entry = declared?.[k];
		if (Array.isArray(entry)) return entry.length > 0;
		return existsSync(join(root, k));
	});
	const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
	return { name: text(pkg.name), version: text(pkg.version), description: text(pkg.description), kinds };
}
