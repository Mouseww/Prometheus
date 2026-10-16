import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts", "apps/server/test/**/*.test.ts", "apps/web/test/**/*.test.ts"],
	},
});
