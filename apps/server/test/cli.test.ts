import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRole } from "../src/cli.ts";

describe("resolveRole", () => {
	it("leaves a normal server untouched", () => {
		expect(resolveRole([], {}, "/h")).toEqual({ role: "server", env: {} });
		expect(resolveRole(["--role", "server"], {}, "/h")).toEqual({ role: "server", env: { PROMETHEUS_ROLE: "server" } });
	});

	it("--role hub equals PROMETHEUS_ROLE=hub and brings the hub defaults", () => {
		const expected = { role: "hub", env: { PROMETHEUS_PORT: "7421", PROMETHEUS_HOME: join("/h", ".prometheus-hub") } };
		expect(resolveRole(["--role=hub"], {}, "/h")).toEqual({ ...expected, env: { PROMETHEUS_ROLE: "hub", ...expected.env } });
		expect(resolveRole([], { PROMETHEUS_ROLE: "hub" }, "/h")).toEqual(expected);
	});

	it("never overrides a port or data directory the operator set", () => {
		expect(resolveRole(["--role", "hub"], { PROMETHEUS_PORT: "9000", PROMETHEUS_HOME: "/data" }, "/h")).toEqual({ role: "hub", env: { PROMETHEUS_ROLE: "hub" } });
	});

	it("the flag wins over the environment and a bad value is refused", () => {
		expect(resolveRole(["--role", "server"], { PROMETHEUS_ROLE: "hub" }, "/h").role).toBe("server");
		expect(() => resolveRole(["--role", "hubb"], {}, "/h")).toThrow();
		expect(() => resolveRole(["--role"], {}, "/h")).toThrow();
	});
});
