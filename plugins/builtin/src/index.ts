import lancedb from "@prometheus/knowledge-lancedb";
import automations from "@prometheus/plugin-automations";
import computerUse from "@prometheus/plugin-computer-use";
import connectors from "@prometheus/plugin-connectors";
import folder from "@prometheus/plugin-folder";
import git from "@prometheus/plugin-git";
import mcp from "@prometheus/plugin-mcp";
import memory from "@prometheus/plugin-memory";
import packages from "@prometheus/plugin-packages";
import modes from "@prometheus/plugin-modes";
import type { PrometheusPlugin } from "@prometheus/plugin-sdk";
import skills from "@prometheus/plugin-skills";
import ssh from "@prometheus/plugin-ssh";
import subagents from "@prometheus/plugin-subagents";
import terminal from "@prometheus/plugin-terminal";
import todos from "@prometheus/plugin-todos";
import veil from "@prometheus/plugin-veil";
import voice from "@prometheus/plugin-voice";
import workbench from "@prometheus/plugin-workbench";

/**
 * Plugins every Prometheus host ships with; each is an ordinary plugin and can serve as a template.
 *
 * The order is the order Settings → Prometheus Plugins lists them, so it is grouped by purpose:
 * knowledge and tools the agent can reach, then how a chat behaves, then workspace tooling.
 * `modes` stays last on purpose: it rewrites the whole system prompt from `before_agent_start`, so
 * every extension that adds a prompt section (memory, connectors, workbench) has to run before it.
 */
export const builtinPlugins: PrometheusPlugin[] = [
	// Knowledge and capabilities
	lancedb,
	memory,
	skills,
	mcp,
	connectors,
	ssh,
	computerUse,
	packages,
	// Chat behaviour
	todos,
	subagents,
	voice,
	veil,
	// Workspace tools
	git,
	automations,
	terminal,
	folder,
	workbench,
	// Rewrites the final system prompt: keep it after everything above.
	modes,
];
