import type { HubDeps } from "../deps.ts";
import type { Router } from "../http/router.ts";

/**
 * Extension point for block 2C (model gateways, quotas, usage, `/api/models`, `/llm/:format/*` proxy).
 * 2C replaces this body.
 */
export function registerModelRoutes(_router: Router, _deps: HubDeps): void {}
