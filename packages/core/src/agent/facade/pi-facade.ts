// PiFacade (docs/agent-runtime.md §9): lets legacy `ctx.extension((pi) => ...)` plugins work under
// non-PI runtimes. Their factories run against a recording fake `pi`; what they registered is
// translated into the runtime-neutral model (PluginTool, ContextProvider) or kept for later phases.
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ContextProvider, ContextRequest, PluginLogger, PluginTool, PluginToolContext } from "@prometheus/plugin-sdk";

/** Loosely typed on purpose: the real PI event/context types are not available outside PI. */
export type Handler = (event: any, ctx: any) => any;

export const HOOK_NAMES = ["tool_call", "session_start", "session_shutdown", "resources_discover", "before_provider_request", "before_provider_headers"] as const;
export type HookName = (typeof HOOK_NAMES)[number];

export interface CapturedCommand {
	name: string;
	description?: string;
	handler: (args: string, ctx: any) => unknown;
}

export interface Captured {
	tools: PluginTool[];
	/** One per `before_agent_start` handler; its output is always delivered as `turn`. */
	contextProviders: ContextProvider[];
	commands: CapturedCommand[];
	mcpServers: { name: string; config: Parameters<ExtensionAPI["registerMcpServer"]>[1] }[];
	/** Recorded, not executed here. */
	hooks: Record<HookName, Handler[]>;
	providers: { name: string; config: unknown }[];
	warnings: string[];
}

export interface CaptureOptions {
	pluginName: string;
	cwd: string;
	log: PluginLogger;
	/** Receives `pi.sendMessage(...)` calls; without it they are dropped with a warning. */
	sendMessage?: (message: unknown, options?: unknown) => void;
}

const noop = () => undefined;

const NO_UI: PluginToolContext["ui"] = {
	confirm: async () => false,
	select: async () => undefined,
	input: async () => undefined,
	notify: noop,
};

/** Legacy code calls PI UI methods we do not have (setStatus, setWidget, ...): those become no-ops. */
function lenientUi(base: PluginToolContext["ui"] = NO_UI): any {
	return new Proxy(base as any, {
		get: (target, prop) => {
			if (prop in target) return target[prop];
			if (typeof prop === "symbol" || prop === "then") return undefined;
			return noop;
		},
	});
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Replays `factories` against a recording fake `pi` and returns what they registered. Factories may
 * be async; one that throws is recorded as a warning and does not stop the others.
 */
export async function captureExtension(factories: ExtensionFactory[], opts: CaptureOptions): Promise<Captured> {
	const { pluginName, log } = opts;
	const captured: Captured = {
		tools: [],
		contextProviders: [],
		commands: [],
		mcpServers: [],
		hooks: { tool_call: [], session_start: [], session_shutdown: [], resources_discover: [], before_provider_request: [], before_provider_headers: [] },
		providers: [],
		warnings: [],
	};
	const warned = new Set<string>();
	const warn = (text: string) => {
		captured.warnings.push(text);
		log.warn(text);
	};
	const warnOnce = (key: string, text: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		warn(text);
	};
	const unsupported = (what: string) => `${pluginName}: pi.${what} is not supported outside PI`;

	/** What `before_agent_start` handlers see: a mutable draft whose sections and guidelines we read back. */
	const contextFor = (sessionId: string | undefined, cwd: string) => ({
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		hasUI: false,
		ui: lenientUi(),
	});

	const provideFromHandler = (handler: Handler): ContextProvider => async (req: ContextRequest) => {
		const systemPromptOptions = { cwd: req.cwd, promptGuidelines: [] as string[], sections: {} as Record<string, string> };
		const event = { type: "before_agent_start", prompt: req.prompt, messageType: req.messageType ?? "user", systemPrompt: "", systemPromptOptions };
		const result = await handler(event, contextFor(req.sessionId, req.cwd));

		const parts: string[] = [];
		const guidelines = systemPromptOptions.promptGuidelines.filter((g) => typeof g === "string" && g.trim());
		if (guidelines.length) parts.push(guidelines.map((g) => `- ${g}`).join("\n"));
		for (const [key, value] of Object.entries(systemPromptOptions.sections)) {
			if (typeof value === "string" && value.trim()) parts.push(`## ${key}\n${value}`);
		}
		if (result && typeof result === "object") {
			if ("systemPrompt" in result) {
				warnOnce("before_agent_start.systemPrompt", `${pluginName}: before_agent_start returned systemPrompt, which replaces the whole prompt in PI; delivered as turn context outside PI`);
				const text = (result as { systemPrompt?: unknown }).systemPrompt;
				if (typeof text === "string" && text !== event.systemPrompt && text.trim()) parts.push(text);
			}
			if ("message" in result && result.message !== undefined) {
				warnOnce("before_agent_start.message", `${pluginName}: before_agent_start returned message, which is not supported outside PI`);
			}
		}
		return parts.length ? { turn: parts.join("\n\n") } : undefined;
	};

	const addTool = (def: any) => {
		if (!def || typeof def.name !== "string" || !def.name.trim() || typeof def.execute !== "function") {
			warn(`${pluginName}: pi.registerTool ignored a tool without a name or execute`);
			return;
		}
		const tool: PluginTool = {
			name: def.name,
			label: def.label,
			description: def.description,
			parameters: def.parameters,
			...(def.promptSnippet !== undefined && { promptSnippet: def.promptSnippet }),
			...(def.promptGuidelines !== undefined && { promptGuidelines: def.promptGuidelines }),
			...(def.annotations !== undefined && { annotations: def.annotations }),
			...(def.defaultActive !== undefined && { defaultActive: def.defaultActive }),
			async execute(toolCallId, params, signal, onUpdate, toolCtx) {
				// Only what PluginToolContext can supply; the rest of PI's context stays undefined.
				const legacyCtx = {
					cwd: toolCtx.cwd,
					hasUI: toolCtx.hasUI,
					ui: lenientUi(toolCtx.ui),
					signal,
					sessionManager: { getSessionId: () => toolCtx.sessionId },
				};
				const args = typeof def.prepareArguments === "function" ? def.prepareArguments(params) : params;
				return def.execute(toolCallId, args, signal, onUpdate, legacyCtx);
			},
		};
		const at = captured.tools.findIndex((t) => t.name === tool.name);
		if (at >= 0) captured.tools[at] = tool;
		else captured.tools.push(tool);
	};

	const impl = {
		registerTool: addTool,
		on(event: string, handler: Handler) {
			if (typeof handler !== "function") return noop;
			if (event === "before_agent_start") captured.contextProviders.push(provideFromHandler(handler));
			else if ((HOOK_NAMES as readonly string[]).includes(event)) captured.hooks[event as HookName].push(handler);
			else warnOnce(`on:${event}`, unsupported(`on("${event}")`));
			return noop;
		},
		registerCommand(name: string, options: { description?: string; handler: CapturedCommand["handler"] }) {
			captured.commands.push({ name, description: options?.description, handler: options?.handler });
		},
		registerMcpServer(name: string, config: Captured["mcpServers"][number]["config"]) {
			captured.mcpServers.push({ name, config });
		},
		registerProvider(nameOrProvider: unknown, config?: unknown) {
			const name = typeof nameOrProvider === "string" ? nameOrProvider : String((nameOrProvider as { id?: unknown } | undefined)?.id ?? "(unnamed)");
			captured.providers.push({ name, config: typeof nameOrProvider === "string" ? config : nameOrProvider });
			warnOnce(`registerProvider:${name}`, unsupported(`registerProvider("${name}")`));
		},
		getAllTools: () => captured.tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations })),
		getActiveTools: () => captured.tools.map((t) => t.name),
		setActiveTools() {
			warnOnce("setActiveTools", unsupported("setActiveTools"));
		},
		sendMessage(message: unknown, options?: unknown) {
			if (opts.sendMessage) opts.sendMessage(message, options);
			else warnOnce("sendMessage", unsupported("sendMessage"));
		},
	};

	const pi = new Proxy(impl as Record<string | symbol, unknown>, {
		get: (target, prop) => {
			if (prop in target) return target[prop];
			if (typeof prop === "symbol" || prop === "then") return undefined;
			warnOnce(`api:${prop}`, unsupported(prop));
			return noop;
		},
	}) as unknown as ExtensionAPI;

	for (const factory of factories) {
		try {
			await factory(pi);
		} catch (err) {
			warn(`${pluginName}: extension failed: ${errorText(err)}`);
		}
	}
	return captured;
}
