// How an ACP agent is pointed at a Prometheus gateway (through the local relay). ACP itself has no way to choose an
// endpoint, so this is per agent: the environment and switches its CLI understands. Agents without an entry use their
// own login only.
import { basename, extname } from "node:path";
import type { GatewayFormat } from "@prometheus/protocol";

export interface AcpGatewayAdapter {
	/** Protocols the agent can speak to the relay, best first. */
	formats: readonly GatewayFormat[];
	/** Environment and extra arguments for a session that uses `model` of a gateway behind `baseUrl` (the relay). */
	launch(o: { baseUrl: string; token: string; model: string; format: GatewayFormat }): { env: Record<string, string>; args: string[] };
}

const ADAPTERS: Record<string, AcpGatewayAdapter> = {
	// Qwen Code: OpenAI-compatible endpoint from the environment (`--auth-type openai`).
	qwen: {
		formats: ["openai-completions"],
		launch: ({ baseUrl, token, model }) => ({ env: { OPENAI_API_KEY: token, OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_MODEL: model }, args: ["--auth-type", "openai", "--model", model] }),
	},
};

/** The adapter for an agent's command (by its file name, so a full path or an npm shim works too). */
export function acpGatewayAdapter(command: string | undefined): AcpGatewayAdapter | undefined {
	if (!command) return undefined;
	const name = basename(command, extname(command)).toLowerCase();
	return ADAPTERS[name];
}
