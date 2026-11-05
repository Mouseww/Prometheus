import type { HubDeps } from "../deps.ts";
import type { Router } from "../http/router.ts";

/**
 * Extension point for block 2B (workspaces, git smart HTTP, merge requests, files/diff API).
 * 2B replaces this body, may call `deps.registry.register("workspaces", ...)` and mounts under `/api/...`, `/git/*`.
 */
export function registerGitRoutes(_router: Router, _deps: HubDeps): void {}
