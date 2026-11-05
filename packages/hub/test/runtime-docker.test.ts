import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cpuPercentOf, createDockerClient, DockerApiError, localEndpoints, memMbOf, parseDockerUrl, splitImage } from "../src/runtime/docker-api.ts";
import { buildContainerPayload, containerName, createDockerDriver } from "../src/runtime/docker-driver.ts";
import type { ExecutorNode, TenantSpec } from "../src/runtime/driver.ts";

interface Call {
	method: string;
	path: string;
	body: unknown;
}

interface FakeEngine {
	calls: Call[];
	server: Server;
	imageKnown: boolean;
	pullError?: string;
	stale: boolean;
	listen(target: number | string): Promise<void>;
	close(): Promise<void>;
}

function fakeEngine(): FakeEngine {
	const calls: Call[] = [];
	const engine: FakeEngine = {
		calls,
		imageKnown: false,
		stale: false,
		server: createServer((req: IncomingMessage, res: ServerResponse) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				const url = req.url ?? "";
				calls.push({ method: req.method ?? "", path: url, body: raw ? JSON.parse(raw) : undefined });
				const json = (status: number, body: unknown): void => {
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(body));
				};
				const route = `${req.method} ${url.split("?")[0]}`;
				if (route === "GET /_ping") return void res.end("OK");
				if (route.startsWith("GET /images/") && route.endsWith("/json")) return engine.imageKnown ? json(200, { Id: "img" }) : json(404, { message: "No such image" });
				if (route === "POST /images/create") {
					res.writeHead(200, { "content-type": "application/json" });
					return void res.end(engine.pullError ? `{"status":"Pulling"}\n{"error":"${engine.pullError}"}\n` : '{"status":"Pulling"}\n{"status":"Downloaded"}\n');
				}
				if (route === "GET /containers/prometheus-tenant-u1/json") return engine.stale ? json(200, { Id: "stale1" }) : json(404, { message: "No such container" });
				if (route === "GET /containers/nope/json") return json(404, { message: "No such container" });
				if (route === "POST /containers/create") return json(201, { Id: "abc123" });
				if (route === "POST /containers/abc123/start") return void res.writeHead(204).end();
				if (route === "GET /containers/abc123/json") return json(200, { Id: "abc123", State: { Running: true }, NetworkSettings: { Ports: { "7420/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } } });
				if (route === "POST /containers/abc123/stop") return void res.writeHead(204).end();
				if (route === "DELETE /containers/abc123" || route === "DELETE /containers/stale1") return void res.writeHead(204).end();
				if (route === "GET /containers/abc123/stats") {
					return json(200, {
						cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 },
						precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
						memory_stats: { usage: 300 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
					});
				}
				json(500, { message: `unexpected ${route}` });
			});
		}),
		listen: (target) => new Promise<void>((resolve) => engine.server.listen(target as never, resolve as never)),
		close: () => new Promise<void>((resolve) => engine.server.close(() => resolve())),
	};
	return engine;
}

const engines: FakeEngine[] = [];
afterEach(async () => {
	for (const e of engines.splice(0)) await e.close();
});

async function tcpEngine(): Promise<{ engine: FakeEngine; url: string }> {
	const engine = fakeEngine();
	engines.push(engine);
	await engine.listen(0);
	return { engine, url: `tcp://127.0.0.1:${(engine.server.address() as AddressInfo).port}` };
}

const spec: TenantSpec = { userId: "u1", root: join("/srv/tenants", "u1"), env: { PROMETHEUS_HOME: "/data", PROMETHEUS_TOKEN: "t" }, cpuLimit: 1.5, memLimitMb: 1024 };

describe("parseDockerUrl and endpoints", () => {
	it("parses unix, npipe and tcp addresses", () => {
		expect(parseDockerUrl("unix:///var/run/docker.sock")).toEqual({ kind: "socket", path: "/var/run/docker.sock" });
		expect(parseDockerUrl("npipe:////./pipe/docker_engine")).toEqual({ kind: "socket", path: "//./pipe/docker_engine" });
		expect(parseDockerUrl("npipe://\\\\.\\pipe\\dockerDesktopLinuxEngine")).toEqual({ kind: "socket", path: "//./pipe/dockerDesktopLinuxEngine" });
		expect(parseDockerUrl("tcp://10.0.0.5:2375")).toEqual({ kind: "tcp", host: "10.0.0.5", port: 2375, tls: undefined });
		expect(() => parseDockerUrl("ftp://x")).toThrow("无法解析");
		expect(() => parseDockerUrl("https://10.0.0.5:2376")).toThrow("证书目录");
	});

	it("loads client certificates for TLS endpoints", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hub-tls-"));
		for (const f of ["ca.pem", "cert.pem", "key.pem"]) await writeFile(join(dir, f), `pem:${f}`);
		const e = parseDockerUrl("tcp://node1:2376", dir);
		expect(e).toEqual({ kind: "tcp", host: "node1", port: 2376, tls: { ca: "pem:ca.pem", cert: "pem:cert.pem", key: "pem:key.pem" } });
	});

	it("picks endpoints from DOCKER_HOST or the platform default", () => {
		expect(localEndpoints({ DOCKER_HOST: "tcp://127.0.0.1:2375" }, "linux")).toEqual([{ kind: "tcp", host: "127.0.0.1", port: 2375, tls: undefined }]);
		expect(localEndpoints({}, "linux")).toEqual([{ kind: "socket", path: "/var/run/docker.sock" }]);
		expect(localEndpoints({}, "win32")).toEqual([
			{ kind: "socket", path: "//./pipe/docker_engine" },
			{ kind: "socket", path: "//./pipe/dockerDesktopLinuxEngine" },
		]);
	});

	it("splits image names", () => {
		expect(splitImage("prometheus:local")).toEqual({ from: "prometheus", tag: "local" });
		expect(splitImage("registry:5000/team/app")).toEqual({ from: "registry:5000/team/app", tag: "latest" });
		expect(splitImage("repo/app@sha256:abc")).toEqual({ from: "repo/app@sha256:abc", tag: "" });
	});
});

describe("docker client against a fake engine", () => {
	it("speaks the Engine API over TCP", async () => {
		const { engine, url } = await tcpEngine();
		const c = createDockerClient({ endpoint: parseDockerUrl(url) });
		expect(await c.ping()).toBe(true);
		expect(await c.imageExists("prometheus:local")).toBe(false);
		await c.pullImage("prometheus:local");
		const created = await c.createContainer("prometheus-tenant-u1", { Image: "x" });
		expect(created.Id).toBe("abc123");
		await c.startContainer("abc123");
		expect((await c.inspectContainer("abc123"))?.NetworkSettings?.Ports?.["7420/tcp"]?.[0]?.HostPort).toBe("49153");
		expect(await c.inspectContainer("nope")).toBeUndefined();
		await c.stopContainer("abc123", 7);
		await c.removeContainer("abc123");
		expect(engine.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
			"GET /_ping",
			"GET /images/prometheus:local/json",
			"POST /images/create?fromImage=prometheus&tag=local",
			"POST /containers/create?name=prometheus-tenant-u1",
			"POST /containers/abc123/start",
			"GET /containers/abc123/json",
			"GET /containers/nope/json",
			"POST /containers/abc123/stop?t=7",
			"DELETE /containers/abc123?force=true&v=true",
		]);
		expect(engine.calls[3]?.body).toEqual({ Image: "x" });
	});

	it("speaks the Engine API over a unix socket or named pipe", async () => {
		const engine = fakeEngine();
		engines.push(engine);
		let url: string;
		if (process.platform === "win32") {
			const name = `prom-test-${process.pid}-${Date.now()}`;
			await engine.listen(`\\\\.\\pipe\\${name}`);
			url = `npipe:////./pipe/${name}`;
		} else {
			const dir = await mkdtemp(join(tmpdir(), "hub-sock-"));
			await mkdir(dir, { recursive: true });
			const path = join(dir, "docker.sock");
			await engine.listen(path);
			url = `unix://${path}`;
		}
		const c = createDockerClient({ endpoint: parseDockerUrl(url) });
		expect(await c.ping()).toBe(true);
		expect((await c.createContainer("prometheus-tenant-u1", { Image: "x" })).Id).toBe("abc123");
	});

	it("reports an unreachable engine as not available", async () => {
		const c = createDockerClient({ endpoint: { kind: "tcp", host: "127.0.0.1", port: 1 } });
		expect(await c.ping()).toBe(false);
	});

	it("turns engine errors into DockerApiError with the daemon's message", async () => {
		const { url } = await tcpEngine();
		const c = createDockerClient({ endpoint: parseDockerUrl(url) });
		await expect(c.startContainer("missing")).rejects.toMatchObject({ name: "DockerApiError", status: 500, message: expect.stringContaining("unexpected POST /containers/missing/start") });
		expect(new DockerApiError(404, "x").status).toBe(404);
	});

	it("surfaces a pull error that arrives mid-stream", async () => {
		const { engine, url } = await tcpEngine();
		engine.pullError = "manifest unknown";
		await expect(createDockerClient({ endpoint: parseDockerUrl(url) }).pullImage("nope:1")).rejects.toThrow("manifest unknown");
	});

	it("computes cpu percent and memory like the docker CLI", () => {
		const s = {
			cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 },
			precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
			memory_stats: { usage: 300 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
		};
		expect(cpuPercentOf(s)).toBe(80);
		expect(memMbOf(s)).toBe(200);
		expect(cpuPercentOf({})).toBeUndefined();
	});
});

describe("container payload", () => {
	it("is hardened as specified", () => {
		const payload = buildContainerPayload(spec, { image: "prometheus:local", runtime: undefined, network: undefined, remote: false });
		expect(payload).toEqual({
			Image: "prometheus:local",
			User: "10001:10001",
			Env: ["PROMETHEUS_HOME=/data", "PROMETHEUS_TOKEN=t"],
			ExposedPorts: { "7420/tcp": {} },
			Labels: { "prometheus.tenant": "u1" },
			HostConfig: {
				Binds: [`${join(spec.root, "data")}:/data:rw`, `${join(spec.root, "work")}:/workspace:rw`, `${join(spec.root, "policy")}:/policy:ro`],
				PortBindings: { "7420/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
				ReadonlyRootfs: true,
				Tmpfs: { "/tmp": "rw,nosuid,size=512m" },
				CapDrop: ["ALL"],
				SecurityOpt: ["no-new-privileges"],
				NanoCpus: 1_500_000_000,
				Memory: 1024 * 1024 * 1024,
				MemorySwap: 1024 * 1024 * 1024,
				PidsLimit: 512,
				NetworkMode: "bridge",
				RestartPolicy: { Name: "no" },
				ExtraHosts: ["host.docker.internal:host-gateway"],
			},
		});
	});

	it("adds the gVisor runtime, a custom network and remote publishing when configured", () => {
		const payload = buildContainerPayload(spec, { image: "img", runtime: "runsc", network: "tenants", remote: true }) as { HostConfig: Record<string, any> };
		expect(payload.HostConfig.Runtime).toBe("runsc");
		expect(payload.HostConfig.NetworkMode).toBe("tenants");
		expect(payload.HostConfig.PortBindings["7420/tcp"][0].HostIp).toBe("0.0.0.0");
	});

	it("names containers safely", () => {
		expect(containerName("01HX/../ABC")).toBe("prometheus-tenant-01hx-..-abc");
	});
});

describe("docker driver", () => {
	const makeDriver = async (engine: FakeEngine, url: string, extra: Partial<Parameters<typeof createDockerDriver>[0]> = {}) => {
		const client = createDockerClient({ endpoint: parseDockerUrl(url) });
		return createDockerDriver({ env: {}, image: "prometheus:local", clientFor: () => client, ...extra });
	};

	it("pulls a missing image, replaces a stale container, starts and finds the published port", async () => {
		const { engine, url } = await tcpEngine();
		engine.stale = true;
		const driver = await makeDriver(engine, url);
		expect(driver.kind).toBe("docker");
		expect(await driver.available()).toBe(true);
		const handle = await driver.start(spec);
		expect(handle).toEqual({ userId: "u1", host: "127.0.0.1", port: 49153, containerId: "abc123" });
		const order = engine.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
		expect(order).toEqual([
			"GET /_ping",
			"GET /images/prometheus:local/json",
			"POST /images/create",
			"GET /containers/prometheus-tenant-u1/json",
			"DELETE /containers/stale1",
			"POST /containers/create",
			"POST /containers/abc123/start",
			"GET /containers/abc123/json",
		]);
		expect(await driver.stats(handle)).toEqual({ cpuPercent: 80, memMb: 200 });
		await driver.stop(handle);
		expect(engine.calls.slice(-2).map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual(["POST /containers/abc123/stop", "DELETE /containers/abc123"]);
	});

	it("skips the pull when the image exists and honours HUB_DOCKER_RUNTIME / HUB_TENANT_NETWORK", async () => {
		const { engine, url } = await tcpEngine();
		engine.imageKnown = true;
		const driver = await makeDriver(engine, url, { runtime: "runsc", network: "tenants" });
		await driver.start(spec);
		expect(engine.calls.some((c) => c.path.startsWith("/images/create"))).toBe(false);
		const create = engine.calls.find((c) => c.path.startsWith("/containers/create"))?.body as { HostConfig: Record<string, unknown> };
		expect(create.HostConfig).toMatchObject({ Runtime: "runsc", NetworkMode: "tenants" });
	});

	it("uses the node's address for remote placement", async () => {
		const { engine, url } = await tcpEngine();
		engine.imageKnown = true;
		const node: ExecutorNode = { id: "n1", name: "node1", dockerUrl: "tcp://10.1.2.3:2375", cpuCapacity: 4, memCapacityMb: 8192, status: "active" };
		const driver = await makeDriver(engine, url);
		const handle = await driver.start({ ...spec, node });
		expect(handle.host).toBe("10.1.2.3");
		const create = engine.calls.find((c) => c.path.startsWith("/containers/create"))?.body as { HostConfig: { PortBindings: Record<string, { HostIp: string }[]> } };
		expect(create.HostConfig.PortBindings["7420/tcp"]?.[0]?.HostIp).toBe("0.0.0.0");
	});

	it("removes the container when start fails", async () => {
		const { engine, url } = await tcpEngine();
		engine.imageKnown = true;
		const client = createDockerClient({ endpoint: parseDockerUrl(url) });
		const driver = createDockerDriver({
			env: {},
			clientFor: () => ({ ...client, startContainer: async () => Promise.reject(new Error("boom")) }),
		});
		await expect(driver.start(spec)).rejects.toThrow("boom");
		expect(engine.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/containers/abc123?force=true&v=true" });
	});

	it("reports unavailable when the engine does not answer", async () => {
		const driver = createDockerDriver({ env: {}, clientFor: () => createDockerClient({ endpoint: { kind: "tcp", host: "127.0.0.1", port: 1 } }) });
		expect(await driver.available()).toBe(false);
	});
});
