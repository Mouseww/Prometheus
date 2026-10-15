import lancedb from "@prometheus/knowledge-lancedb";
import mcp from "@prometheus/plugin-mcp";
import memory from "@prometheus/plugin-memory";
import packages from "@prometheus/plugin-packages";
import type { PrometheusPlugin } from "@prometheus/plugin-sdk";
import skills from "@prometheus/plugin-skills";

/** Plugins every Prometheus host ships with; each is an ordinary plugin and can serve as a template. */
export const builtinPlugins: PrometheusPlugin[] = [lancedb, mcp, skills, memory, packages];
