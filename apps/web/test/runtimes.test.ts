import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/backend.ts", () => ({ isTauri: () => true, loadMode: () => "local" }));
import { noteToolResult, useRuntimes } from "../src/lib/runtimes.ts";

const item = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	name: id,
	description: "",
	version: "1",
	sizeMb: 10,
	installed: null,
	supported: true,
	hint: null,
	installing: false,
	system: null,
	notice: null,
	msvcInstallable: false,
	...over,
});

describe("noteToolResult", () => {
	beforeEach(() => {
		useRuntimes.setState({ available: true, requests: {}, items: [item("python"), item("go"), item("rust", { installed: "stable" })] as never });
	});

	it("asks to install python when bash says it is missing", () => {
		noteToolResult("bash", { content: [{ type: "text", text: "bash: python3: command not found" }] });
		expect(useRuntimes.getState().requests.python?.command).toBe("python3");
	});

	it("understands PowerShell and the Windows Store stub", () => {
		noteToolResult("powershell", "The term 'go' is not recognized as the name of a cmdlet");
		expect(useRuntimes.getState().requests.go?.command).toBe("go");
	});

	it("stays quiet for installed runtimes, unknown commands and other tools", () => {
		noteToolResult("bash", "bash: cargo: command not found");
		noteToolResult("bash", "bash: foobar: command not found");
		noteToolResult("read", "python: command not found");
		expect(useRuntimes.getState().requests).toEqual({});
	});

	it("does nothing when this shell cannot install runtimes", () => {
		useRuntimes.setState({ available: false });
		noteToolResult("bash", "bash: python: command not found");
		expect(useRuntimes.getState().requests).toEqual({});
	});
});
