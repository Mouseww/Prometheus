import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { MAX_BUFFER, ShellSession, shellSpec } from "../src/shell.ts";

const wait = async (s: ShellSession, pred: (all: string) => boolean, ms = 15_000) => {
	const end = Date.now() + ms;
	for (;;) {
		const all = s.read(0).data;
		if (pred(all)) return all;
		if (Date.now() > end) throw new Error(`timeout; output: ${JSON.stringify(all)}`);
		await new Promise((r) => setTimeout(r, 100));
	}
};

describe("ShellSession", () => {
	it("runs commands in the given folder and keeps state between them", async () => {
		const dir = await realpath(await mkdtemp(`${tmpdir()}/term-`));
		const s = new ShellSession("t", dir);
		try {
			s.run("echo first-marker");
			await wait(s, (a) => a.includes("first-marker\n") || a.includes("first-marker\r\n"));
			s.run(shellSpec().command.startsWith("powershell") ? "$x = 'kept-value'" : "x=kept-value");
			s.run(shellSpec().command.startsWith("powershell") ? "Write-Output $x" : "echo $x");
			const out = await wait(s, (a) => /^kept-value\r?$/m.test(a));
			expect(out).toContain("> echo first-marker");
		} finally {
			s.close();
		}
	});

	it("reads incrementally by offset", async () => {
		const s = new ShellSession("t", tmpdir());
		try {
			s.run("echo one");
			await wait(s, (a) => /^one\r?$/m.test(a));
			const r = s.read(0);
			s.run("echo two");
			await wait(s, (a) => /^two\r?$/m.test(a));
			const more = s.read(r.next);
			expect(more.data).toContain("two");
			expect(more.data).not.toContain("one\n");
		} finally {
			s.close();
		}
	});

	it("interrupt replaces a stuck command with a fresh shell", async () => {
		const s = new ShellSession("t", tmpdir());
		try {
			s.run(process.platform === "win32" ? "Start-Sleep 60" : "sleep 60");
			await new Promise((r) => setTimeout(r, 500));
			s.interrupt();
			s.run("echo alive-again");
			await wait(s, (a) => /^alive-again\r?$/m.test(a));
			expect(s.alive).toBe(true);
		} finally {
			s.close();
		}
	});

	it("caps its buffer and keeps offsets absolute", () => {
		const s = new ShellSession("t", tmpdir(), { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], init: "" });
		try {
			// @ts-expect-error private, exercised on purpose
			s.append("x".repeat(MAX_BUFFER + 10));
			const r = s.read(0);
			expect(r.data.length).toBe(MAX_BUFFER);
			expect(r.next).toBe(MAX_BUFFER + 10);
			expect(s.read(r.next).data).toBe("");
		} finally {
			s.close();
		}
	});
});
