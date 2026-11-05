// Mounted once in the app shell: feeds the team execution store from the team plugin's stream while the plugin is on.
import { useEffect } from "react";
import { pluginActive, useStore } from "../../lib/store.ts";
import { watchTeamEvents } from "../execStore.ts";

export function ExecBridge() {
	const client = useStore((s) => s.client);
	const active = useStore((s) => pluginActive(s.plugins, "team"));
	useEffect(() => {
		if (!client || !active) return;
		return watchTeamEvents(client);
	}, [client, active]);
	return null;
}
