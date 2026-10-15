import type { McpExposure, McpServerSpec } from "@prometheus/protocol";

export const NAME_PATTERN = /^[a-zA-Z0-9][\w-]{0,47}$/;
const EXPOSURES: readonly McpExposure[] = ["codemode", "deferred", "direct", "hidden"];
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Placeholder returned to clients instead of secret values; sending it back keeps the stored value. */
export const MASK = "••••••";

function stringRecord(value: unknown, keyPattern: RegExp, label: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是键值对象`);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (!keyPattern.test(k)) throw new Error(`${label} 键名不合法：${k}`);
		if (typeof v !== "string") throw new Error(`${label}.${k} 必须是字符串`);
		out[k] = v;
	}
	return out;
}

/** Normalise untrusted client input into a spec; throws with a readable message. */
export function parseSpec(raw: unknown): McpServerSpec {
	if (!raw || typeof raw !== "object") throw new Error("缺少服务器配置");
	const r = raw as Record<string, unknown>;
	const type = r.type === "http" ? "http" : r.type === "stdio" ? "stdio" : undefined;
	if (!type) throw new Error("type 必须是 stdio 或 http");
	const exposure = r.exposure === undefined ? undefined : (r.exposure as McpExposure);
	if (exposure !== undefined && !EXPOSURES.includes(exposure)) throw new Error("exposure 取值不合法");
	const timeout = r.timeout === undefined ? undefined : Number(r.timeout);
	if (timeout !== undefined && !(timeout > 0 && timeout <= 3600)) throw new Error("timeout 需在 1–3600 秒之间");
	const spec: McpServerSpec = {
		type,
		description: typeof r.description === "string" && r.description.trim() ? r.description.trim().slice(0, 500) : undefined,
		exposure,
		enabled: r.enabled !== false,
		timeout,
	};
	if (type === "stdio") {
		if (typeof r.command !== "string" || !r.command.trim()) throw new Error("stdio 服务器需要 command");
		spec.command = r.command.trim();
		if (r.args !== undefined) {
			if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string")) throw new Error("args 必须是字符串数组");
			spec.args = r.args as string[];
		}
		spec.env = stringRecord(r.env, ENV_PATTERN, "env");
		if (typeof r.cwd === "string" && r.cwd.trim()) spec.cwd = r.cwd.trim();
	} else {
		if (typeof r.url !== "string") throw new Error("http 服务器需要 url");
		let url: URL;
		try {
			url = new URL(r.url);
		} catch {
			throw new Error("url 不是合法地址");
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url 必须是 http(s) 地址");
		spec.url = url.toString();
		spec.headers = stringRecord(r.headers, HEADER_PATTERN, "headers");
	}
	return spec;
}

/** Values that reference env vars (`${NAME}`) are not secrets and stay visible. */
function maskRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, /^\$\{[A-Za-z_]\w*\}$/.test(v) ? v : MASK]));
}

export function redactSpec(spec: McpServerSpec): McpServerSpec {
	return { ...spec, env: maskRecord(spec.env), headers: maskRecord(spec.headers) };
}

function unmaskRecord(next: Record<string, string> | undefined, prev: Record<string, string> | undefined) {
	if (!next) return undefined;
	return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === MASK ? (prev?.[k] ?? "") : v]));
}

/** Restore secret values the client sent back as the mask placeholder. */
export function mergeSpec(next: McpServerSpec, prev: McpServerSpec | undefined): McpServerSpec {
	return { ...next, env: unmaskRecord(next.env, prev?.env), headers: unmaskRecord(next.headers, prev?.headers) };
}

/** Shape PI's registerMcpServer / mcp.json expect. */
export function toPiConfig(spec: McpServerSpec): Record<string, unknown> {
	const base = { description: spec.description, exposure: spec.exposure, enabled: spec.enabled, timeout: spec.timeout };
	return spec.type === "stdio"
		? { ...base, type: "stdio", command: spec.command, args: spec.args, env: spec.env, cwd: spec.cwd }
		: { ...base, type: "http", url: spec.url, headers: spec.headers };
}

/** Read-only view of a PI mcp.json entry. */
export function fromPiConfig(raw: unknown): McpServerSpec | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const isHttp = typeof r.url === "string";
	if (!isHttp && typeof r.command !== "string") return undefined;
	return {
		type: isHttp ? "http" : "stdio",
		command: isHttp ? undefined : (r.command as string),
		args: Array.isArray(r.args) ? (r.args as string[]) : undefined,
		url: isHttp ? (r.url as string) : undefined,
		env: r.env as Record<string, string> | undefined,
		headers: r.headers as Record<string, string> | undefined,
		description: typeof r.description === "string" ? r.description : undefined,
		exposure: r.exposure as McpExposure | undefined,
		enabled: r.enabled !== false,
	};
}
