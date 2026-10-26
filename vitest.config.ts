import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// The Claude Code conformance tests start real CLI processes; slower tests sharing the machine need headroom.
		testTimeout: 30_000,
		hookTimeout: 60_000,
		include: ["packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
	},
});
