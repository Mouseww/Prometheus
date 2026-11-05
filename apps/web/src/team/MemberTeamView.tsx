// Member mode entry: the "team" view of the normal app. Calls go through the local team plugin.
import { TeamShell } from "./TeamShell.tsx";
import { memberPlugin, memberTeamApi } from "./memberTransport.ts";

export default function MemberTeamView() {
	return <TeamShell api={memberTeamApi()} mode="member" plugin={memberPlugin()} />;
}
