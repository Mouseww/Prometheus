// Administrator locks inside REAL PI sessions (no model, no network): the main session never declares a disabled
// tool, and a subagent child (no gate, no user extensions) gets the same exclusion plus the policy-only guard.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, createAgentSession, DefaultResourceLoader, type InlineExtension, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PI_CHILD_TOOLS } from "@prometheus/subagents";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PermissionGate } from "../src/permission-gate.ts";
import { EXIT_PLAN_MODE, READ_OUTSIDE_DENIED_REASON, TOOL_DISABLED_REASON } from "../src/permissions.ts";
import { type GuardPolicy, policyGuardExtension, READ_OUTSIDE_UNATTENDED_REASON } from "../src/policy-guard.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
let root: string;
let cwd: string;
let agentDir: string;
let previousAgentDir: string | undefined;
let modelRuntime: ModelRuntime;
const sessions: AgentSession[] = [];

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "policy-pi-"));
	cwd = join(root, "work");
	agentDir = join(root, "agent");
	await mkdir(cwd);
	previousAgentDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = agentDir;
	modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
});

afterAll(async () => {
	for (const s of sessions) s.dispose();
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** An extension tool, like a plugin or MCP tool, that the administrator may also disable. */
const pluginTool: InlineExtension = {
	name: "test:plugin-tool",
	factory: (pi) => {
		pi.registerTool({
			name: "neutral_echo",
			label: "echo",
			description: "echoes",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echo" }], details: {} }),
		});
	},
};

async function open(opts: { factories: InlineExtension[]; noExtensions?: boolean; tools?: string[]; excludeTools?: string[] }): Promise<AgentSession> {
	const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: opts.factories, ...(opts.noExtensions ? { noExtensions: true } : {}) });
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: loader,
		...(opts.tools ? { tools: opts.tools } : {}),
		...(opts.excludeTools ? { excludeTools: opts.excludeTools } : {}),
	});
	sessions.push(session);
	await session.bindExtensions({ mode: "rpc" });
	return session;
}

const names = (s: AgentSession) => s.getAllTools().map((t) => t.name);

describe("main session: disabled tools are not declared to the model", () => {
	it("drops built-in and extension tools from the registry and the active set, other tools stay", async () => {
		const gate = new PermissionGate();
		const s = await open({ factories: [pluginTool, gate.extension()], excludeTools: ["bash", "neutral_echo"] });
		for (const gone of ["bash", "neutral_echo"]) {
			expect(names(s)).not.toContain(gone);
			expect(s.getActiveToolNames()).not.toContain(gone);
		}
		for (const kept of ["read", "edit", "write"]) expect(s.getActiveToolNames()).toContain(kept);
	});

	it("keeps them out after setActiveToolsByName (plan mode toggle) and a reload", async () => {
		const gate = new PermissionGate();
		const s = await open({ factories: [pluginTool, gate.extension()], excludeTools: ["bash", "neutral_echo"] });
		// What PiRuntimeSession.onPermissionMode does when plan mode starts.
		s.setActiveToolsByName([...s.getActiveToolNames(), EXIT_PLAN_MODE, "bash", "neutral_echo"]);
		expect(s.getActiveToolNames()).toContain(EXIT_PLAN_MODE);
		expect(s.getActiveToolNames()).not.toContain("bash");
		expect(s.getActiveToolNames()).not.toContain("neutral_echo");
		await s.reload();
		expect(names(s)).not.toContain("bash");
		expect(names(s)).not.toContain("neutral_echo");
		expect(s.getActiveToolNames()).toContain("read");
	});

	it("accepts wildcard patterns", async () => {
		const s = await open({ factories: [pluginTool], excludeTools: ["neutral_*"] });
		expect(names(s)).not.toContain("neutral_echo");
		expect(names(s)).toContain("bash");
	});

	it("without exclusions everything is declared", async () => {
		const s = await open({ factories: [pluginTool] });
		expect(s.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "neutral_echo"]));
	});
});

describe("subagent child: no gate, policy-only guard", () => {
	const child = (policy: GuardPolicy) =>
		open({
			factories: [policyGuardExtension(policy)],
			noExtensions: true,
			tools: PI_CHILD_TOOLS,
			...(policy.disabledTools?.length ? { excludeTools: [...policy.disabledTools] } : {}),
		});
	const call = (s: AgentSession, toolName: string, input: Record<string, unknown>) =>
		s.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "t1", toolName, input } as never);

	it("excludes disabled tools after the allowlist; the rest of the child tools remain", async () => {
		const s = await child({ disabledTools: ["bash"] });
		expect(s.getActiveToolNames().sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
		expect(names(s)).not.toContain("bash");
	});

	it("loads the guard even though user and package extensions are off", async () => {
		const s = await child({ disabledTools: ["bash"] });
		expect(await call(s, "bash", { command: "ls" })).toMatchObject({ block: true, reason: TOOL_DISABLED_REASON });
	});

	it("blocks an outside-cwd read under deny", async () => {
		const s = await child({ readOutsideProject: "deny" });
		const outside = join(root, "elsewhere", "secret.txt");
		expect(await call(s, "read", { path: outside })).toMatchObject({ block: true, reason: READ_OUTSIDE_DENIED_REASON });
		expect(await call(s, "bash", { command: `cat ${outside}` })).toMatchObject({ block: true });
	});

	it("turns ask into a block with a clear reason, since a child cannot ask", async () => {
		const s = await child({ readOutsideProject: "ask" });
		expect(await call(s, "read", { path: join(root, "elsewhere", "secret.txt") })).toMatchObject({ block: true, reason: READ_OUTSIDE_UNATTENDED_REASON });
	});

	it("leaves normal calls alone", async () => {
		const s = await child({ disabledTools: ["write"], readOutsideProject: "deny" });
		expect(await call(s, "read", { path: join(cwd, "a.txt") })).toBeUndefined();
		expect(await call(s, "bash", { command: "npm test" })).toBeUndefined();
		expect(await call(s, "edit", { path: join(cwd, "a.txt"), edits: [] })).toBeUndefined();
	});
});
