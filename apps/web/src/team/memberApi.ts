// Member mode transport: the browser never holds a Hub token. Every call is relayed by the local team plugin
// (`team` / `hub.request`), which owns the Hub session; realtime comes back as plugin stream topic `hub:<topic>`.
import { createApiMethods, type Requester, type TeamApi, TeamApiError, type TeamEvent, type Unsubscribe, unwrapEnvelope } from "./api.ts";

export const TEAM_PLUGIN = "team";
export const HUB_REQUEST_METHOD = "hub.request";

/** Must reject on failure (unlike the store's toasting `pluginCall`). Resolves with the Hub envelope or its data. */
export type PluginCall = (plugin: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
/** Subscribes to a plugin stream topic; returns the unsubscribe function. */
export type PluginWatch = (plugin: string, topic: string, cb: (data: unknown) => void) => Unsubscribe;

export function createMemberApi(pluginCall: PluginCall, pluginWatch?: PluginWatch): TeamApi {
	const requester: Requester = {
		async request<T>(method: string, path: string, body?: unknown): Promise<T> {
			let result: unknown;
			try {
				result = await pluginCall(TEAM_PLUGIN, HUB_REQUEST_METHOD, body === undefined ? { method, path } : { method, path, body });
			} catch (err) {
				if (err instanceof TeamApiError) throw err;
				throw new TeamApiError(0, "plugin", err instanceof Error ? err.message : String(err));
			}
			if (result === undefined) throw new TeamApiError(0, "noResponse", "No response from the team plugin");
			return unwrapEnvelope<T>(result);
		},
	};
	return {
		...createApiMethods(requester),
		subscribe(topic: string, cb: (event: TeamEvent) => void): Unsubscribe {
			return pluginWatch ? pluginWatch(TEAM_PLUGIN, `hub:${topic}`, cb) : () => undefined;
		},
	};
}
