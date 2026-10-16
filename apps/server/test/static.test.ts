import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWebRoot } from "../src/static.ts";

describe("defaultWebRoot", () => {
	const here = resolve("/opt/app/server");

	it("uses the web folder shipped beside main.js in an installed app", () => {
		const seen: string[] = [];
		const root = defaultWebRoot(here, (p) => (seen.push(p), true));
		expect(root).toBe(join(here, "web"));
		expect(seen).toEqual([join(here, "web", "index.html")]);
	});

	it("falls back to apps/web/dist in a source checkout", () => {
		expect(defaultWebRoot(here, () => false)).toBe(resolve(here, "../../web/dist"));
	});
});
