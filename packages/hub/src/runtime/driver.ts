/** An executor node (enterprise mode): a Docker Engine the Hub can place tenant containers on. */
export interface ExecutorNode {
	id: string;
	name: string;
	dockerUrl: string;
	tlsDir?: string | undefined;
	cpuCapacity: number;
	memCapacityMb: number;
	status: "active" | "draining" | "offline";
}

export type RuntimeKind = "docker" | "sandbox" | "restricted";

export interface TenantSpec {
	userId: string;
	/** `<tenantRoot>/<userId>`: holds `data/`, `work/` and `policy/`. */
	root: string;
	env: Record<string, string>;
	cpuLimit: number;
	memLimitMb: number;
	node?: ExecutorNode | undefined;
}

export interface TenantHandle {
	userId: string;
	host: string;
	port: number;
	containerId?: string;
	pid?: number;
}

export interface RuntimeDriver {
	readonly kind: RuntimeKind;
	/** Why `available()` is false, for the admin UI (for example `adminRequired`). */
	unavailableReason?(): string | undefined;
	available(): Promise<boolean>;
	start(spec: TenantSpec): Promise<TenantHandle>;
	stop(handle: TenantHandle): Promise<void>;
	stats(handle: TenantHandle): Promise<{ cpuPercent?: number; memMb?: number }>;
	/** Optional: the last lines the tenant printed, for failure messages. */
	tail?(userId: string): string;
	/** Optional: calls `cb` once when the tenant process or container ends without `stop`. Process drivers use it for crash restarts. */
	onExit?(handle: TenantHandle, cb: (info: { code: number | null }) => void): void;
}

/** Sub-directories of a tenant root and the paths a tenant sees, which differ between a container and a host process. */
export interface TenantLayout {
	data: string;
	work: string;
	policyDir: string;
	policyFile: string;
	keyFile: string;
}

export function hostLayout(root: string, join: (...p: string[]) => string): TenantLayout {
	const policyDir = join(root, "policy");
	return { data: join(root, "data"), work: join(root, "work"), policyDir, policyFile: join(policyDir, "policy.json"), keyFile: join(policyDir, "hub-trust.pem") };
}

/** Where the tenant finds things inside a container (see the docker driver's bind mounts). */
export const CONTAINER_LAYOUT: TenantLayout = {
	data: "/data",
	work: "/workspace",
	policyDir: "/policy",
	policyFile: "/policy/policy.json",
	keyFile: "/policy/hub-trust.pem",
};

export const CONTAINER_PORT = 7420;
