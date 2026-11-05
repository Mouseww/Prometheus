import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupMember } from "../src/member/index.ts";
import { type FakeCtx, fakeCtx, waitFor } from "./harness.ts";

const STUB = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(process.env.STUB_OUT, JSON.stringify({ argv: process.argv.slice(2), home: process.env.PROMETHEUS_HOME, token: process.env.PROMETHEUS_TOKEN, host: process.env.PROMETHEUS_HOST, port: process.env.PROMETHEUS_PORT }));
createServer((req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true, role: "hub" }));
}).listen(Number(process.env.PROMETHEUS_PORT), "127.0.0.1");
`;

let dir: string;
let ctx: FakeCtx;
let out: string;
let port: number;

const freePort = async (): Promise<number> => {
	const s = createServer();
	await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
	const p = (s.address() as AddressInfo).port;
	await new Promise<void>((resolve) => s.close(() => resolve()));
	return p;
};

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "team-local-hub-"));
	const entry = join(dir, "stub-server.mjs");
	await writeFile(entry, STUB);
	out = join(dir, "stub-out.json");
	process.env.STUB_OUT = out;
	port = await freePort();
	ctx = fakeCtx(dir);
	await setupMember(ctx, { localHub: { entry, execArgv: [], home: join(dir, "home") } });
});
afterAll(async () => {
	delete process.env.STUB_OUT;
	await ctx.call("localHub.stop");
	await ctx.dispose();
});

describe("localHub.*", () => {
	it("starts the current server entry with --role hub, its own home and a random token, bound to loopback by default", async () => {
		expect(await ctx.call("localHub.status")).toEqual({ running: false });
		const started = await ctx.call("localHub.start", { port });
		expect(started).toMatchObject({ running: true, ready: true, host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` });
		expect(started.token).toMatch(/^[0-9a-f]{48}$/);

		const seen = JSON.parse(await readFile(out, "utf8"));
		expect(seen.argv).toEqual(["--role", "hub"]);
		expect(seen).toMatchObject({ home: join(dir, "home", ".prometheus-hub"), host: "127.0.0.1", port: String(port), token: started.token });

		const again = await ctx.call("localHub.start", { port });
		expect(again.pid).toBe(started.pid);
		expect((await ctx.call("localHub.status")).running).toBe(true);
	});

	it("stops the child and forgets it", async () => {
		const before = await ctx.call("localHub.status");
		const stopped = await ctx.call("localHub.stop");
		expect(stopped).toEqual({ running: false });
		await waitFor(() => {
			try {
				process.kill(before.pid, 0);
				return false;
			} catch {
				return true;
			}
		}, "子进程退出");
		expect(await ctx.call("localHub.status")).toEqual({ running: false });
	});

	it("binds to all interfaces only when the caller confirms with lan: true", async () => {
		await expect(ctx.call("localHub.start", { host: "0.0.0.0", port })).rejects.toThrow(/lan/);
		await expect(ctx.call("localHub.start", { host: "192.168.1.5", port })).rejects.toThrow(/lan/);

		const started = await ctx.call("localHub.start", { lan: true, port });
		expect(started).toMatchObject({ running: true, host: "0.0.0.0" });
		expect(JSON.parse(await readFile(out, "utf8")).host).toBe("0.0.0.0");
		await ctx.call("localHub.stop");
	});
});
