import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateGateway } from "@prometheus/gateway";
import { type AdminPolicy, AppError, type GatewayConfig, PERMISSION_MODES, type PermissionMode, type PublicAdminPolicy } from "@prometheus/protocol";

const KEYS: ReadonlySet<string> = new Set(["serverOwner", "forbiddenModes", "defaultPermission", "readOutsideProject", "pluginAllowlist", "gateways", "disabledTools", "managedBy"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isMode = (v: unknown): v is PermissionMode => PERMISSION_MODES.includes(v as PermissionMode);

function invalid(detail: string): never {
	throw new AppError("policyInvalid", { detail });
}

/** Checks a parsed policy file. Unknown keys are refused too: a misspelt lock must not silently do nothing. */
export function parsePolicy(raw: unknown): AdminPolicy {
	if (!isRecord(raw)) invalid("policy must be a JSON object");
	for (const key of Object.keys(raw)) if (!KEYS.has(key)) invalid(`unknown key "${key}"`);
	const out: AdminPolicy = {};
	if (raw.serverOwner !== undefined) {
		if (typeof raw.serverOwner !== "string" || !raw.serverOwner.trim()) invalid("serverOwner must be a non-empty string");
		out.serverOwner = raw.serverOwner.trim();
	}
	if (raw.forbiddenModes !== undefined) {
		if (!Array.isArray(raw.forbiddenModes) || !raw.forbiddenModes.every(isMode)) invalid(`forbiddenModes must be a list of ${PERMISSION_MODES.join(", ")}`);
		out.forbiddenModes = [...new Set(raw.forbiddenModes)];
	}
	if (raw.defaultPermission !== undefined) {
		if (!isMode(raw.defaultPermission)) invalid(`defaultPermission must be one of ${PERMISSION_MODES.join(", ")}`);
		if (out.forbiddenModes?.includes(raw.defaultPermission)) invalid("defaultPermission is also in forbiddenModes");
		out.defaultPermission = raw.defaultPermission;
	}
	if (raw.readOutsideProject !== undefined) {
		if (raw.readOutsideProject !== "allow" && raw.readOutsideProject !== "ask" && raw.readOutsideProject !== "deny") invalid('readOutsideProject must be "allow", "ask" or "deny"');
		out.readOutsideProject = raw.readOutsideProject;
	}
	if (raw.pluginAllowlist !== undefined) {
		if (!Array.isArray(raw.pluginAllowlist) || !raw.pluginAllowlist.every((p) => typeof p === "string" && p)) invalid("pluginAllowlist must be a list of plugin names");
		out.pluginAllowlist = [...new Set(raw.pluginAllowlist as string[])];
	}
	if (raw.gateways !== undefined) {
		if (!Array.isArray(raw.gateways) || !raw.gateways.every(isRecord)) invalid("gateways must be a list of gateway objects");
		const gateways = raw.gateways as unknown as GatewayConfig[];
		for (const g of gateways) {
			const errors = validateGateway(g);
			if (errors.length) invalid(`gateway ${String(g.id)}: ${errors.join("; ")}`);
		}
		out.gateways = gateways;
	}
	if (raw.disabledTools !== undefined) {
		if (!Array.isArray(raw.disabledTools) || !raw.disabledTools.every((t) => typeof t === "string" && t.trim())) invalid("disabledTools must be a list of non-empty tool names");
		out.disabledTools = [...new Set((raw.disabledTools as string[]).map((t) => t.trim()))];
	}
	if (raw.managedBy !== undefined) {
		if (typeof raw.managedBy !== "string") invalid("managedBy must be a string");
		out.managedBy = raw.managedBy;
	}
	return out;
}

/**
 * `PROMETHEUS_POLICY` wins over `<dataDir>/policy.json`; a missing file means no policy, a broken one throws.
 *
 * Security note: a policy.json inside a data folder the user can write is not tamper-proof, since whoever can edit the
 * file can lift every lock (including `serverOwner`). A deployment that relies on the policy against its own user (a
 * Hub tenant) must point PROMETHEUS_POLICY at a path the user cannot write, such as a read-only mount.
 */
export async function loadPolicy(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<AdminPolicy | undefined> {
	const explicit = env.PROMETHEUS_POLICY?.trim();
	const file = explicit || join(dataDir, "policy.json");
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (err) {
		// An explicitly named file that cannot be read is a mistake, not "no policy".
		if ((err as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return undefined;
		console.error(`[prometheus] 无法读取策略文件 ${file}：${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}
	try {
		return parsePolicy(JSON.parse(text));
	} catch (err) {
		console.error(`[prometheus] 策略文件 ${file} 无效，已拒绝启动：${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}
}

/** Whether the policy bans switching to the mode. */
export function modeForbidden(policy: Readonly<AdminPolicy> | undefined, mode: PermissionMode): boolean {
	return policy?.forbiddenModes?.includes(mode) ?? false;
}

/** The mode itself if the policy allows it, otherwise the policy default, otherwise "default". */
export function allowedMode(policy: Readonly<AdminPolicy> | undefined, mode: PermissionMode): PermissionMode {
	if (!modeForbidden(policy, mode)) return mode;
	const fallback = policy?.defaultPermission;
	return fallback && !modeForbidden(policy, fallback) ? fallback : "default";
}

/** What clients may see: gateways without their keys, headers or model lists. */
export function publicPolicy(policy: Readonly<AdminPolicy>): PublicAdminPolicy {
	const { gateways, ...rest } = policy;
	return { ...rest, ...(gateways ? { gateways: gateways.map((g) => ({ id: g.id, name: g.name, format: g.format, baseUrl: g.baseUrl })) } : {}) };
}

/** Policy gateways first; a local gateway with the same id is replaced. */
export function mergeGateways(local: GatewayConfig[], policy: Readonly<AdminPolicy> | undefined): GatewayConfig[] {
	if (!policy?.gateways) return local;
	const ids = new Set(policy.gateways.map((g) => g.id));
	return [...policy.gateways, ...local.filter((g) => !ids.has(g.id))];
}
