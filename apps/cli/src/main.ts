#!/usr/bin/env node
// Prometheus TUI: PI's native interactive mode with Prometheus gateways, knowledge and plugins injected.
import { main } from "@earendil-works/pi-coding-agent";
import { bootstrap, gatewayExtension } from "@prometheus/core";
import { builtinPlugins } from "@prometheus/builtin-plugins";

const runtime = await bootstrap({ host: "tui", builtinPlugins });

try {
	await main(process.argv.slice(2), {
		extensionFactories: [{ name: "prometheus:gateway", factory: gatewayExtension(runtime.config) }, ...runtime.extensions()],
	});
} finally {
	await runtime.dispose();
}
