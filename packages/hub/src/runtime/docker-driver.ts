import { createDockerClient, cpuPercentOf, type DockerClient, localEndpoints, memMbOf, parseDockerUrl } from "./docker-api.ts";
import { CONTAINER_LAYOUT, CONTAINER_PORT, type ExecutorNode, type RuntimeDriver, type TenantHandle, type TenantSpec } from "./driver.ts";
import { join } from "node:path";

export const TENANT_UID = 10001;
export const PIDS_LIMIT = 512;
export const DEFAULT_TENANT_IMAGE = "prometheus:local";

export interface DockerDriverOptions {
	env?: NodeJS.ProcessEnv;
	/** `HUB_TENANT_IMAGE`. */
	image?: string;
	/** `HUB_DOCKER_RUNTIME`, for example `runsc` (gVisor). */
	runtime?: string;
	/** `HUB_TENANT_NETWORK`; default bridge. */
	network?: string;
	/** Tests: builds the client for a node (or the local engine when undefined). */
	clientFor?: (node: ExecutorNode | undefined) => DockerClient;
	log?: (message: string) => void;
}

export interface ContainerPayloadOptions {
	image: string;
	runtime?: string | undefined;
	network?: string | undefined;
	remote: boolean;
}

/** The `containers/create` body. Pure so it can be snapshot-tested. */
export function buildContainerPayload(spec: TenantSpec, opts: ContainerPayloadOptions): Record<string, unknown> {
	const hostIp = opts.remote ? "0.0.0.0" : "127.0.0.1";
	const memory = Math.round(spec.memLimitMb * 1024 * 1024);
	const hostConfig: Record<string, unknown> = {
		Binds: [`${join(spec.root, "data")}:${CONTAINER_LAYOUT.data}:rw`, `${join(spec.root, "work")}:${CONTAINER_LAYOUT.work}:rw`, `${join(spec.root, "policy")}:${CONTAINER_LAYOUT.policyDir}:ro`],
		PortBindings: { [`${CONTAINER_PORT}/tcp`]: [{ HostIp: hostIp, HostPort: "" }] },
		ReadonlyRootfs: true,
		Tmpfs: { "/tmp": "rw,nosuid,size=512m" },
		CapDrop: ["ALL"],
		SecurityOpt: ["no-new-privileges"],
		NanoCpus: Math.round(spec.cpuLimit * 1e9),
		Memory: memory,
		MemorySwap: memory,
		PidsLimit: PIDS_LIMIT,
		NetworkMode: opts.network ?? "bridge",
		RestartPolicy: { Name: "no" },
		ExtraHosts: ["host.docker.internal:host-gateway"],
	};
	if (opts.runtime) hostConfig.Runtime = opts.runtime;
	return {
		Image: opts.image,
		User: `${TENANT_UID}:${TENANT_UID}`,
		Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
		ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} },
		Labels: { "prometheus.tenant": spec.userId },
		HostConfig: hostConfig,
	};
}

export const containerName = (userId: string): string => `prometheus-tenant-${userId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;

function nodeHost(node: ExecutorNode): string {
	const u = parseDockerUrl(node.dockerUrl, node.tlsDir);
	return u.kind === "tcp" ? u.host : "127.0.0.1";
}

export function createDockerDriver(options: DockerDriverOptions = {}): RuntimeDriver {
	const env = options.env ?? process.env;
	const image = options.image ?? env.HUB_TENANT_IMAGE?.trim() ?? DEFAULT_TENANT_IMAGE;
	const runtime = options.runtime ?? (env.HUB_DOCKER_RUNTIME?.trim() || undefined);
	const network = options.network ?? (env.HUB_TENANT_NETWORK?.trim() || undefined);
	const clients = new Map<string, DockerClient>();
	let localClient: DockerClient | undefined;

	const clientFor = (node: ExecutorNode | undefined): DockerClient => {
		if (options.clientFor) return options.clientFor(node);
		if (node) {
			const cached = clients.get(node.id);
			if (cached) return cached;
			const c = createDockerClient({ endpoint: parseDockerUrl(node.dockerUrl, node.tlsDir) });
			clients.set(node.id, c);
			return c;
		}
		if (localClient) return localClient;
		throw new Error("本机 Docker 尚未探测，请先调用 available()");
	};

	// stop() only gets the handle, so remember which node a container lives on.
	const nodeOf = new Map<string, ExecutorNode | undefined>();

	return {
		kind: "docker",
		async available() {
			if (options.clientFor) return clientFor(undefined).ping();
			for (const endpoint of localEndpoints(env)) {
				const c = createDockerClient({ endpoint });
				if (await c.ping()) {
					localClient = c;
					return true;
				}
			}
			return false;
		},
		async start(spec) {
			if (!spec.node && !localClient && !options.clientFor && !(await this.available())) throw new Error("本机 Docker 不可用");
			const client = clientFor(spec.node);
			if (!(await client.imageExists(image))) {
				options.log?.(`拉取租户镜像 ${image}`);
				await client.pullImage(image);
			}
			const name = containerName(spec.userId);
			const stale = await client.inspectContainer(name);
			if (stale) await client.removeContainer(stale.Id, true);
			const created = await client.createContainer(name, buildContainerPayload(spec, { image, runtime, network, remote: spec.node !== undefined }));
			try {
				await client.startContainer(created.Id);
				const info = await client.inspectContainer(created.Id);
				const binding = info?.NetworkSettings?.Ports?.[`${CONTAINER_PORT}/tcp`]?.[0];
				const port = Number(binding?.HostPort);
				if (!Number.isInteger(port) || port <= 0) throw new Error("容器没有发布端口");
				nodeOf.set(created.Id, spec.node);
				const handle: TenantHandle = { userId: spec.userId, host: spec.node ? nodeHost(spec.node) : "127.0.0.1", port, containerId: created.Id };
				return handle;
			} catch (err) {
				await client.removeContainer(created.Id, true).catch(() => {});
				throw err;
			}
		},
		async stop(handle) {
			if (!handle.containerId) return;
			const client = clientFor(nodeOf.get(handle.containerId));
			try {
				await client.stopContainer(handle.containerId, 10);
			} finally {
				await client.removeContainer(handle.containerId, true).catch(() => {});
				nodeOf.delete(handle.containerId);
			}
		},
		async stats(handle) {
			if (!handle.containerId) return {};
			const s = await clientFor(nodeOf.get(handle.containerId)).containerStats(handle.containerId);
			const cpuPercent = cpuPercentOf(s);
			const memMb = memMbOf(s);
			return { ...(cpuPercent !== undefined ? { cpuPercent } : {}), ...(memMb !== undefined ? { memMb } : {}) };
		},
		onExit(handle, cb) {
			const id = handle.containerId;
			if (!id) return;
			const timer = setInterval(() => {
				if (!nodeOf.has(id)) return void clearInterval(timer);
				void clientFor(nodeOf.get(id))
					.inspectContainer(id)
					.then((info) => {
						if (info?.State?.Running) return;
						clearInterval(timer);
						if (nodeOf.has(id)) cb({ code: info?.State?.ExitCode ?? null });
					})
					.catch(() => {});
			}, 5000);
			timer.unref();
		},
	};
}
