import type { HubDeps } from "../deps.ts";
import type { Router } from "../http/router.ts";
import { registerAccountRoutes } from "./account.ts";
import { registerAdminRoutes } from "./admin.ts";
import { registerGitRoutes } from "./git.ts";
import { registerModelRoutes } from "./models.ts";
import { registerSessionRoutes } from "./sessions.ts";
import { registerTeamRoutes } from "./teams.ts";

/** Single composition point. 2A routes first, then the extension points owned by 2B and 2C. */
export function registerRoutes(router: Router, deps: HubDeps): void {
	registerAccountRoutes(router, deps);
	registerAdminRoutes(router, deps);
	registerTeamRoutes(router, deps);
	registerGitRoutes(router, deps);
	registerSessionRoutes(router, deps);
	registerModelRoutes(router, deps);
}
