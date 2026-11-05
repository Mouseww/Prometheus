import type { HubDeps } from "../deps.ts";
import type { Router } from "../http/router.ts";

/**
 * Extension point for block 2C (session mirror, grants, relay, fork, notifications, board, reports, WebSocket).
 * 2C replaces this body; install the upgrade handler with `deps.setUpgradeHandler` and schedulers with `deps.onClose`.
 */
export function registerSessionRoutes(_router: Router, _deps: HubDeps): void {}
