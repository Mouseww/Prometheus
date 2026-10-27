import { describe, expect, it } from "vitest";
import { gatewayAs, gatewayFormats, pickGatewayFormat } from "../src/index.ts";

const g = { format: "openai-completions" as const, baseUrl: "https://x.test/v1", alternates: { "anthropic-messages": "https://x.test", "openai-responses": "  " } as Record<string, string> };

describe("gateway formats", () => {
	it("lists the primary first and skips blank alternates", () => {
		expect(gatewayFormats(g as never)).toEqual(["openai-completions", "anthropic-messages"]);
		expect(gatewayFormats({ format: "openai-responses" })).toEqual(["openai-responses"]);
	});

	it("views the gateway over another protocol with its own base URL", () => {
		const a = gatewayAs(g as never, "anthropic-messages");
		expect(a?.format).toBe("anthropic-messages");
		expect(a?.baseUrl).toBe("https://x.test");
		expect(gatewayAs(g as never, "openai-completions")).toBe(g);
		expect(gatewayAs(g as never, "google-generative-ai")).toBeUndefined();
		expect(gatewayAs(g as never, "openai-responses")).toBeUndefined();
	});

	it("picks the first preferred protocol the gateway speaks", () => {
		expect(pickGatewayFormat(g as never, ["openai-responses", "anthropic-messages"])).toBe("anthropic-messages");
		expect(pickGatewayFormat(g as never, ["google-generative-ai"])).toBeUndefined();
	});
});
