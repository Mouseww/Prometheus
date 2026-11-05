import type { IncomingMessage } from "node:http";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { HubDeps } from "../deps.ts";
import { validationError } from "../errors.ts";
import { readJsonBody } from "../http/context.ts";
import { createUsageService, type UsageService } from "../services/usage.ts";

/** Body that may be absent entirely (treated as `{}`). */
export async function optionalJson<S extends TSchema>(req: IncomingMessage, schema: S): Promise<Static<S>> {
	const body = (await readJsonBody(req)) ?? {};
	if (!Value.Check(schema, body)) throw validationError("请求参数无效");
	return body as Static<S>;
}

/** The usage service is needed by both the report path (session routes) and the proxy (model routes); whichever registers first creates it. */
export function sharedUsage(deps: HubDeps): UsageService {
	return deps.registry.get<UsageService>("usage") ?? deps.registry.register("usage", createUsageService({ db: deps.db, log: deps.log, now: deps.now }));
}
