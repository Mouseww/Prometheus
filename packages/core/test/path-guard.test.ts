import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commandStaysInside, isInside, normalizeToolPath } from "../src/path-guard.ts";
import { decide } from "../src/permissions.ts";

let root: string;
let cwd: string;
let outside: string;
let canLink = true;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "prometheus-guard-"));
	cwd = join(root, "project");
	outside = join(root, "secret");
	mkdirSync(join(cwd, "src"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(outside, "key.txt"), "secret");
	writeFileSync(join(cwd, "src", "a.ts"), "x");
	try {
		symlinkSync(outside, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
		symlinkSync(join(outside, "missing.txt"), join(cwd, "dangling"), "file");
	} catch {
		canLink = false;
	}
});

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe("normalizeToolPath", () => {
	it("expands the home folder, drops @ and reads file URLs", () => {
		expect(normalizeToolPath("~", cwd)).toBe(homedir());
		expect(normalizeToolPath("~/x", cwd)).toBe(join(homedir(), "x"));
		expect(normalizeToolPath("@src/a.ts", cwd)).toBe(join(cwd, "src", "a.ts"));
		expect(normalizeToolPath(pathToFileURL(join(outside, "key.txt")).href, cwd)).toBe(join(outside, "key.txt"));
	});

	it.runIf(process.platform === "win32")("turns Git-Bash drive paths into Windows paths", () => {
		expect(normalizeToolPath("/c/Users/me", cwd)).toBe("C:\\Users\\me");
		expect(normalizeToolPath("/d", cwd)).toBe("D:\\");
	});

	it("throws on a malformed file URL", () => {
		expect(() => normalizeToolPath("file://bad host/x", cwd)).toThrow();
	});
});

describe("isInside with real paths", () => {
	it("accepts the folder, existing and missing files inside it, and .git", () => {
		expect(isInside(".", cwd)).toBe(true);
		expect(isInside("src/a.ts", cwd)).toBe(true);
		expect(isInside("src/new/file.ts", cwd)).toBe(true);
		expect(isInside(".git/config", cwd)).toBe(true);
	});

	it("refuses tilde, file URLs, drive paths and parent paths that lead out", () => {
		expect(isInside("~/.ssh/id_rsa", cwd)).toBe(false);
		expect(isInside(pathToFileURL(join(outside, "key.txt")).href, cwd)).toBe(false);
		expect(isInside(join(outside, "key.txt"), cwd)).toBe(false);
		expect(isInside("../secret/key.txt", cwd)).toBe(false);
		expect(isInside("@../secret/key.txt", cwd)).toBe(false);
	});

	it("fails closed on an unparsable path", () => {
		expect(isInside("file://bad host/x", cwd)).toBe(false);
		expect(isInside("a\0b", cwd)).toBe(false);
	});

	it("refuses a link inside the project that points outside", () => {
		if (!canLink) return;
		expect(isInside("escape", cwd)).toBe(false);
		expect(isInside("escape/key.txt", cwd)).toBe(false);
		expect(isInside("dangling", cwd)).toBe(false);
	});

	it.runIf(process.platform === "win32")("treats a Git-Bash style path as the drive path it names", () => {
		const drive = outside[0]?.toLowerCase();
		const gitBash = `/${drive}${outside.slice(2).replaceAll("\\", "/")}/key.txt`;
		expect(isInside(gitBash, cwd)).toBe(false);
	});
});

describe("decide: read tool with readOutsideProject = ask", () => {
	const env = { cwd: "", allowed: new Set<string>(), policy: { readOutsideProject: "ask" as const } };
	it("asks for a link that leaves the project", () => {
		if (!canLink) return;
		expect(decide("default", { toolName: "read", input: { path: "escape/key.txt" } }, { ...env, cwd })).toEqual({ type: "ask", noRemember: true });
		expect(decide("default", { toolName: "read", input: { path: "src/a.ts" } }, { ...env, cwd })).toEqual({ type: "allow" });
	});
});

describe("commandStaysInside (allowlist)", () => {
	const ok = (c: string) => commandStaysInside(c, cwd);

	it("allows flags and plain relative paths inside the folder", () => {
		for (const c of ["ls -la", "cat src/a.ts", "git status", "rg foo src", "ls .", "grep -n foo src/a.ts | wc -l", "cat 'src/a.ts'", 'cat "src"/"a.ts"', "rg -n foo -t ts", "ls -la src", "wc -l src/a.ts"]) {
			expect(ok(c), c).toBe(true);
		}
	});

	it("asks for anything that is not a plain relative path", () => {
		for (const c of [
			"cat /etc/passwd",
			"cat \\\\server\\share\\x",
			"ls ~",
			"cat ~/x",
			"cat $HOME/x",
			"cat $x",
			"cat %USERPROFILE%\\x",
			"cat C:\\Windows\\win.ini",
			"cat C:foo",
			"ls ../x",
			"ls ./sub/../other",
			"cat src/../../x",
			"cat '..'/x",
			'cat ".."/x',
			"cat .'.'/x",
			"cat \"..\"'/'x",
			"cat \u2018..\u2019/x",
			"cat \u201C../x\u201D",
			"cat 'unterminated",
			"cat `echo x`",
			"cat \\'x",
		]) {
			expect(ok(c), c).toBe(false);
		}
	});

	it("checks flag values as paths", () => {
		for (const c of ["rg foo --path=/etc", "rg foo --path=../x", "rg --ignore-file=../x foo", "Get-Content -Path:..\\x", "Get-Content -Path:C:\\x", "grep -f/etc/passwd x", "grep -f../x y", "grep -f..\\x y", "rg --x=~/y foo", "ls --color=$X"]) {
			expect(ok(c), c).toBe(false);
		}
		for (const c of ["rg --glob=*.ts foo", "grep -fpatterns.txt x", "Get-Content -Path:src\\a.ts", "rg --max-count=5 foo", "ls -la"]) {
			expect(ok(c), c).toBe(true);
		}
	});

	it("checks every segment of a pipeline", () => {
		expect(ok("cat src/a.ts | head ../x")).toBe(false);
		expect(ok("ls && cat /etc/passwd")).toBe(false);
	});

	it("asks for a link inside the folder that leads out", () => {
		if (!canLink) return;
		expect(ok("cat escape/key.txt")).toBe(false);
		expect(ok("ls escape")).toBe(false);
	});

	it("deny blocks the same reads in every mode instead of asking", () => {
		const env = { cwd, allowed: new Set<string>(), policy: { readOutsideProject: "deny" as const } };
		for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "auto"] as const) {
			expect(decide(mode, { toolName: "bash", input: { command: "cat $HOME/.ssh/id_rsa" } }, env), mode).toMatchObject({ type: "block" });
			expect(decide(mode, { toolName: "read", input: { path: "/etc/passwd" } }, env), mode).toMatchObject({ type: "block" });
			expect(decide(mode, { toolName: "read", input: { path: "src/a.ts" } }, env), mode).not.toMatchObject({ type: "block" });
			expect(decide(mode, { toolName: "bash", input: { command: 'cat "src"/"a.ts"' } }, env), mode).not.toMatchObject({ type: "block" });
		}
	});

	it("shows up in decide for every mode that reads", () => {
		const env = { cwd, allowed: new Set<string>(), policy: { readOutsideProject: "ask" as const } };
		for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "auto"] as const) {
			expect(decide(mode, { toolName: "bash", input: { command: "cat $HOME/.ssh/id_rsa" } }, env), mode).toEqual({ type: "ask", noRemember: true });
			expect(decide(mode, { toolName: "bash", input: { command: 'cat "src"/"a.ts"' } }, env), mode).not.toEqual({ type: "ask", noRemember: true });
		}
	});
});
