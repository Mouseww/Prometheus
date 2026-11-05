import { definePlugin } from "@prometheus/plugin-sdk";
import { setupHubRole } from "./hub-role.ts";
import { setupMember } from "./member/index.ts";

export { setupHubRole } from "./hub-role.ts";
export { setupMember } from "./member/index.ts";

/** Same rule as core's `serverRole()`: `PROMETHEUS_ROLE=hub` (also set by `--role hub`) makes this process a Hub. Plugins do not depend on core. */
export const isHubRole = (env: NodeJS.ProcessEnv = process.env): boolean => env.PROMETHEUS_ROLE?.trim().toLowerCase() === "hub";

export default definePlugin({
	name: "team",
	version: "0.1.0",
	async setup(ctx) {
		// Team collaboration needs the in-process session host; the terminal build has none, so it stays inert there.
		if (ctx.host !== "server") return;
		if (isHubRole()) await setupHubRole(ctx);
		else await setupMember(ctx);
	},
});
