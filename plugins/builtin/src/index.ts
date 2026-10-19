import lancedb from "@prometheus/knowledge-lancedb";
import automations from "@prometheus/plugin-automations";
import connectors from "@prometheus/plugin-connectors";
import git from "@prometheus/plugin-git";
import mcp from "@prometheus/plugin-mcp";
import memory from "@prometheus/plugin-memory";
import packages from "@prometheus/plugin-packages";
import type { PrometheusPlugin } from "@prometheus/plugin-sdk";
import skills from "@prometheus/plugin-skills";
import terminal from "@prometheus/plugin-terminal";
import todos from "@prometheus/plugin-todos";
import voice from "@prometheus/plugin-voice";
import workbench from "@prometheus/plugin-workbench";

/** Plugins every Prometheus host ships with; each is an ordinary plugin and can serve as a template. */
export const builtinPlugins: PrometheusPlugin[] = [lancedb, mcp, skills, memory, packages, todos, git, automations, voice, connectors, workbench, terminal];
