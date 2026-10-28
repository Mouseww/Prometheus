// PI chats retry a dropped provider stream more often than PI's own default, without touching a count the user chose.
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { RETRIES, raiseRetryBudget } from "../src/agent/pi/retry.ts";

describe("provider retry budget", () => {
	it("raises PI's default", () => {
		const s = SettingsManager.inMemory();
		raiseRetryBudget(s);
		expect(s.getRetrySettings().maxRetries).toBe(RETRIES);
	});

	it("keeps a count the user set", () => {
		const s = SettingsManager.inMemory({ retry: { maxRetries: 1 } });
		raiseRetryBudget(s);
		expect(s.getRetrySettings().maxRetries).toBe(1);
	});

	it("treats a stream that ended without a stop reason as retryable", () => {
		expect(isRetryableAssistantError({ stopReason: "error", errorMessage: "Anthropic stream ended without a stop reason" } as never)).toBe(true);
	});
});
