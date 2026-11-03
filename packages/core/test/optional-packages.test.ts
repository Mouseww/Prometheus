import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isOptionalPackage, OPTIONAL_PACKAGES } from "../src/optional-packages.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const declared = (dir: string, name: string): string | undefined => JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).dependencies?.[name];

describe("on-demand npm packages", () => {
	it("install exactly the versions the workspace builds against", () => {
		expect(OPTIONAL_PACKAGES.lancedb.version).toBe(declared("plugins/knowledge-lancedb", "@lancedb/lancedb"));
		expect(OPTIONAL_PACKAGES["claude-agent-sdk"].version).toBe(declared("packages/core", "@anthropic-ai/claude-agent-sdk"));
	});

	it("only knows its own ids", () => {
		expect(isOptionalPackage("lancedb")).toBe(true);
		expect(isOptionalPackage("../etc")).toBe(false);
	});
});
