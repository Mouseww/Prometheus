// Binds createMemberApi to the connected Prometheus server (the store's websocket client).
import { openSession, useStore } from "../lib/store.ts";
import type { MemberPlugin } from "./context.tsx";
import { createMemberApi, TEAM_PLUGIN, type PluginCall, type PluginWatch } from "./memberApi.ts";
import type { TeamApi } from "./api.ts";

const pluginCall: PluginCall = async (plugin, method, params) => {
	const client = useStore.getState().client;
	if (!client) throw new Error("not connected");
	return client.rpc("plugin.call", { plugin, method, params });
};

const pluginWatch: PluginWatch = (plugin, topic, cb) => {
	const client = useStore.getState().client;
	if (!client) return () => undefined;
	const off = client.watch(plugin, topic);
	const unframe = client.onFrame((frame) => {
		if (frame.type === "plugin.event" && frame.plugin === plugin && frame.topic === topic) cb(frame.data);
	});
	return () => {
		unframe();
		off();
	};
};

let cachedPlugin: MemberPlugin | undefined;
/** Plugin RPC and navigation into the host app's chat view (member mode only). */
export function memberPlugin(): MemberPlugin {
	cachedPlugin ??= {
		call: (method, params) => pluginCall(TEAM_PLUGIN, method, params),
		openLocalSession: (sessionId) => void openSession(sessionId),
	};
	return cachedPlugin;
}

let cached: TeamApi | undefined;
/** One shared member-mode TeamApi (the relay holds no state of its own). */
export function memberTeamApi(): TeamApi {
	cached ??= createMemberApi(pluginCall, pluginWatch);
	return cached;
}
