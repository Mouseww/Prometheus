import { describe, expect, it } from "vitest";
import { userMcpServers } from "../src/agent/user-mcp.ts";

const plugins = (servers: { name: string; config: Record<string, unknown> }[]) => ({ externalView: async () => ({ mcpServers: servers }) }) as never;

describe("user MCP servers for non-PI runtimes", () => {
	it("passes enabled stdio and http servers, expands ${VAR}, drops disabled and reserved ones", async () => {
		process.env.MCP_TEST_TOKEN = "t0k";
		const out = await userMcpServers(
			plugins([
				{ name: "files", config: { type: "stdio", command: "npx", args: ["-y", "srv"], env: { A: "${MCP_TEST_TOKEN}" } } },
				{ name: "web", config: { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer ${MCP_TEST_TOKEN}" } } },
				{ name: "off", config: { type: "stdio", command: "x", enabled: false } },
				{ name: "prometheus", config: { type: "stdio", command: "x" } },
				{ name: "bad name!", config: { type: "stdio", command: "x" } },
			]),
		);
		expect(out).toEqual([
			{ name: "files", type: "stdio", command: "npx", args: ["-y", "srv"], env: { A: "t0k" } },
			{ name: "web", type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer t0k" } },
		]);
	});
});
