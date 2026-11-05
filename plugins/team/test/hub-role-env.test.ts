import { describe, expect, it } from "vitest";
import { type HubLike, setupHubRole } from "../src/hub-role.ts";

describe("hub role env passthrough", () => {
	it("hands the plugin env (HUB_TRUST_PROXY and friends) to createHub", async () => {
		const seen: Record<string, unknown>[] = [];
		const hub: HubLike = { handle: async () => true, registry: { require: () => ({}) as never }, close: async () => {} };
		const log = { info: () => {}, warn: () => {}, error: () => {} };
		const env = { HUB_TRUST_PROXY: "10.0.0.0/8" };
		await setupHubRole(
			{ dataDir: "unused-hub-role-env-test", log, route: () => {}, wsRoute: () => {}, onDispose: () => {} },
			{
				env,
				createHub: async (options) => {
					seen.push(options);
					return hub;
				},
			},
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.env).toBe(env);
	});
});
