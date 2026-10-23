import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Subagent definitions as pi-subagents understands them.
 *
 * Nothing here invents a second store: a custom agent is a markdown file under `<agentDir>/agents`,
 * and a change to one of the bundled agents is an entry in `settings.json` →
 * `subagents.agentOverrides`. That is exactly where the PI TUI and `/agents` look, so an agent
 * edited here behaves identically from the command line.
 */

export type PromptMode = "replace" | "append";
export type ContextDefault = "" | "fresh" | "fork";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface AgentDef {
	name: string;
	description: string;
	/** `replace` starts the child from the agent prompt alone; `append` keeps PI's base prompt under it. */
	mode: PromptMode;
	/** The agent's system prompt (markdown body of the file). */
	prompt: string;
	/** Empty inherits the parent session's model. */
	model: string;
	/** Empty uses the agent's own default. */
	thinking: string;
	/** Strict allowlist; empty means the agent keeps PI's default tools. */
	tools: string[];
	/** Context handed to the child: a fresh one, or a fork of the parent conversation. */
	context: ContextDefault;
	inheritProject: boolean;
	inheritGlobal: boolean;
	inheritSkills: boolean;
	/** Minutes before a single run is cut off; 0 keeps the default. */
	timeoutMin: number;
	/** Listed in the parent's prompt so the main agent knows to reach for it. */
	advertise: boolean;
}

export interface AgentView extends AgentDef {
	source: "builtin" | "custom";
	/** A custom file that replaces a bundled agent of the same name. */
	shadows: boolean;
	/** A bundled agent with edits layered on top. */
	modified: boolean;
	disabled: boolean;
	/** Where the definition lives, for display. */
	file?: string;
}

// ---------- frontmatter ----------

interface Entry {
	key: string;
	lines: string[];
}

export interface Parsed {
	entries: Entry[];
	body: string;
}

const KEY_LINE = /^([A-Za-z][\w-]*):[ \t]*(.*)$/;

export function parseAgentFile(text: string): Parsed {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return { entries: [], body: normalized.trim() };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { entries: [], body: normalized.trim() };
	const entries: Entry[] = [];
	for (const line of normalized.slice(4, end).split("\n")) {
		const m = KEY_LINE.exec(line);
		if (m) entries.push({ key: m[1] as string, lines: [line] });
		else if (entries.length && line.trim()) entries[entries.length - 1]?.lines.push(line);
	}
	return { entries, body: normalized.slice(end + 4).trim() };
}

const unquote = (s: string) => {
	const t = s.trim();
	return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t;
};

/** Scalar or block-list value of a key, as one comma-joined string. */
function valueOf(entries: Entry[], key: string): string | undefined {
	const e = entries.find((x) => x.key === key);
	if (!e) return undefined;
	const first = (KEY_LINE.exec(e.lines[0] ?? "")?.[2] ?? "").trim();
	if (first && first !== "|" && first !== ">") return unquote(first);
	return e.lines
		.slice(1)
		.map((l) => l.trim().replace(/^-\s+/, ""))
		.filter(Boolean)
		.join(", ");
}

const list = (v: string | undefined): string[] =>
	(v ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
const flag = (v: string | undefined): boolean | undefined => (v === "true" ? true : v === "false" ? false : undefined);

export function defFromFile(name: string, parsed: Parsed): AgentDef {
	const v = (k: string) => valueOf(parsed.entries, k);
	const ctx = v("defaultContext");
	return {
		name,
		description: v("description") ?? "",
		mode: v("systemPromptMode") === "append" ? "append" : "replace",
		prompt: parsed.body,
		model: v("model") ?? "",
		thinking: v("thinking") ?? "",
		tools: list(v("tools")),
		context: ctx === "fresh" || ctx === "fork" ? ctx : "",
		inheritProject: flag(v("inheritProjectContext")) ?? false,
		inheritGlobal: flag(v("inheritGlobalContext")) ?? false,
		inheritSkills: flag(v("inheritSkills")) ?? false,
		timeoutMin: Math.round((Number(v("timeoutMs")) || 0) / 60_000),
		advertise: flag(v("advertise")) ?? false,
	};
}

/** Frontmatter keys this plugin owns; every other key in an existing file is written back untouched. */
const MANAGED = ["name", "description", "tools", "model", "thinking", "systemPromptMode", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "defaultContext", "timeoutMs", "advertise"];

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function serializeAgent(def: AgentDef, prior?: Parsed): string {
	const set = new Map<string, string | undefined>([
		["name", def.name],
		["description", oneLine(def.description) || undefined],
		["tools", def.tools.length ? def.tools.join(", ") : undefined],
		["model", def.model || undefined],
		["thinking", def.thinking || undefined],
		["systemPromptMode", def.mode],
		["inheritProjectContext", String(def.inheritProject)],
		["inheritGlobalContext", def.inheritGlobal ? "true" : undefined],
		["inheritSkills", String(def.inheritSkills)],
		["defaultContext", def.context || undefined],
		["timeoutMs", def.timeoutMin > 0 ? String(Math.round(def.timeoutMin * 60_000)) : undefined],
		["advertise", def.advertise ? "true" : undefined],
	]);
	const lines: string[] = [];
	const written = new Set<string>();
	for (const e of prior?.entries ?? []) {
		if (!MANAGED.includes(e.key)) {
			lines.push(...e.lines);
			continue;
		}
		const next = set.get(e.key);
		if (next !== undefined) lines.push(`${e.key}: ${next}`);
		written.add(e.key);
	}
	const fresh: string[] = [];
	for (const key of MANAGED) {
		const next = set.get(key);
		if (written.has(key) || next === undefined) continue;
		fresh.push(`${key}: ${next}`);
	}
	return `---\n${[...fresh, ...lines].join("\n")}\n---\n\n${def.prompt.trim()}\n`;
}

// ---------- validation ----------

export const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_PROMPT = 200_000;

export function sanitizeDef(input: unknown, name: string): AgentDef {
	if (!input || typeof input !== "object") throw new Error("子代理数据不合法");
	const r = input as Record<string, unknown>;
	const s = (v: unknown) => (typeof v === "string" ? v : "");
	const thinking = s(r.thinking).trim();
	if (thinking && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new Error("思考强度不合法");
	const context = s(r.context);
	const tools = Array.isArray(r.tools) ? [...new Set(r.tools.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => t && t.length < 160 && !/[,\n]/.test(t)))].slice(0, 200) : [];
	const timeout = Number(r.timeoutMin);
	return {
		name,
		description: oneLine(s(r.description)).slice(0, 500),
		mode: r.mode === "append" ? "append" : "replace",
		prompt: s(r.prompt).slice(0, MAX_PROMPT),
		model: s(r.model).trim().slice(0, 200),
		thinking,
		tools,
		context: context === "fresh" || context === "fork" ? context : "",
		inheritProject: r.inheritProject === true,
		inheritGlobal: r.inheritGlobal === true,
		inheritSkills: r.inheritSkills === true,
		timeoutMin: Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.round(timeout), 24 * 60) : 0,
		advertise: r.advertise === true,
	};
}

// ---------- settings.json overrides ----------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

async function readJson(file: string): Promise<Json> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		return isObj(parsed) ? parsed : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`无法解析 ${file}，为避免覆盖已有设置，已停止写入`);
	}
}

async function writeJson(file: string, value: Json): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
	await rename(tmp, file);
}

/** Override fields this plugin writes; `output`, `skills` and the like are left as the user set them. */
const OVERRIDE_KEYS = ["description", "model", "thinking", "systemPromptMode", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "defaultContext", "tools", "systemPrompt", "advertise"] as const;

/** The override fields that differ between a draft and its bundled base. */
export function diffOverride(base: AgentDef, draft: AgentDef): Json {
	const out: Json = {};
	if (draft.description !== base.description) out.description = draft.description;
	if (draft.model !== base.model) out.model = draft.model || "inherit";
	if (draft.thinking !== base.thinking) out.thinking = draft.thinking || "medium";
	if (draft.mode !== base.mode) out.systemPromptMode = draft.mode;
	if (draft.inheritProject !== base.inheritProject) out.inheritProjectContext = draft.inheritProject;
	if (draft.inheritGlobal !== base.inheritGlobal) out.inheritGlobalContext = draft.inheritGlobal;
	if (draft.inheritSkills !== base.inheritSkills) out.inheritSkills = draft.inheritSkills;
	if (draft.context !== base.context) out.defaultContext = draft.context || false;
	if (draft.tools.join(",") !== base.tools.join(",")) out.tools = draft.tools.length ? draft.tools : "inherit";
	if (draft.prompt.trim() !== base.prompt.trim()) out.systemPrompt = draft.prompt;
	if (draft.advertise !== base.advertise) out.advertise = draft.advertise;
	return out;
}

/** Layer an override over a bundled definition, for display. */
export function applyOverride(base: AgentDef, o: Json | undefined): AgentDef {
	if (!o) return base;
	const next = { ...base, tools: [...base.tools] };
	if (typeof o.description === "string") next.description = o.description;
	if (typeof o.model === "string") next.model = o.model === "inherit" ? "" : o.model;
	if (typeof o.thinking === "string") next.thinking = o.thinking;
	if (o.systemPromptMode === "append" || o.systemPromptMode === "replace") next.mode = o.systemPromptMode;
	if (typeof o.inheritProjectContext === "boolean") next.inheritProject = o.inheritProjectContext;
	if (typeof o.inheritGlobalContext === "boolean") next.inheritGlobal = o.inheritGlobalContext;
	if (typeof o.inheritSkills === "boolean") next.inheritSkills = o.inheritSkills;
	if (o.defaultContext === false) next.context = "";
	else if (o.defaultContext === "fresh" || o.defaultContext === "fork") next.context = o.defaultContext;
	if (Array.isArray(o.tools)) next.tools = o.tools.filter((t): t is string => typeof t === "string");
	else if (o.tools === "inherit" || o.tools === false) next.tools = [];
	if (typeof o.systemPrompt === "string") next.prompt = o.systemPrompt;
	if (typeof o.advertise === "boolean") next.advertise = o.advertise;
	return next;
}

// ---------- the store ----------

export class AgentStore {
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	private get userDir() {
		return join(this.agentDir, "agents");
	}
	private get settingsFile() {
		return join(this.agentDir, "settings.json");
	}

	/** Directories that may hold pi-subagents' bundled agents, most likely first. */
	async builtinDirs(): Promise<string[]> {
		const found: string[] = [];
		const add = (d: string) => existsSync(d) && !found.includes(d) && found.push(d);
		add(join(this.agentDir, "npm", "node_modules", "pi-subagents", "agents"));
		add(join(this.agentDir, "extensions", "subagent", "agents"));
		// Packages installed from git live under git/<host>/<owner>/<repo>.
		const gitRoot = join(this.agentDir, "git");
		const walk = async (dir: string, depth: number): Promise<void> => {
			if (depth > 3) return;
			let names: string[];
			try {
				names = await readdir(dir);
			} catch {
				return;
			}
			if (names.includes("package.json") && names.includes("agents")) {
				try {
					const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string };
					if (pkg.name === "pi-subagents") add(join(dir, "agents"));
				} catch {
					// not a readable manifest
				}
				return;
			}
			for (const n of names) if (!n.startsWith(".") && n !== "node_modules") await walk(join(dir, n), depth + 1);
		};
		await walk(gitRoot, 0);
		return found;
	}

	private async readDir(dir: string, depth = 0): Promise<{ name: string; file: string; parsed: Parsed }[]> {
		let items: import("node:fs").Dirent[];
		try {
			items = await readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const out: { name: string; file: string; parsed: Parsed }[] = [];
		for (const it of items) {
			const file = join(dir, it.name);
			if (it.isDirectory()) {
				if (depth < 3 && !it.name.startsWith(".")) out.push(...(await this.readDir(file, depth + 1)));
				continue;
			}
			if (!it.name.endsWith(".md") || it.name.endsWith(".chain.md")) continue;
			try {
				const parsed = parseAgentFile(await readFile(file, "utf8"));
				const name = valueOf(parsed.entries, "name") || it.name.replace(/\.md$/, "");
				out.push({ name, file, parsed });
			} catch {
				// unreadable file: skip it rather than fail the page
			}
		}
		return out;
	}

	private async overrides(): Promise<{ settings: Json; all: Record<string, Json> }> {
		const settings = await readJson(this.settingsFile);
		const sub = isObj(settings.subagents) ? settings.subagents : {};
		const raw = isObj(sub.agentOverrides) ? sub.agentOverrides : {};
		const all: Record<string, Json> = {};
		for (const [k, v] of Object.entries(raw)) if (isObj(v)) all[k] = v;
		return { settings, all };
	}

	private async writeOverride(name: string, next: Json | undefined): Promise<void> {
		const { settings, all } = await this.overrides();
		if (next && Object.keys(next).length) all[name] = next;
		else delete all[name];
		const sub = isObj(settings.subagents) ? { ...settings.subagents } : {};
		if (Object.keys(all).length) sub.agentOverrides = all;
		else delete sub.agentOverrides;
		const out = { ...settings };
		if (Object.keys(sub).length) out.subagents = sub;
		else delete out.subagents;
		await writeJson(this.settingsFile, out);
	}

	async packageInstalled(): Promise<boolean> {
		if ((await this.builtinDirs()).length) return true;
		const settings = await readJson(this.settingsFile).catch(() => ({}) as Json);
		return Array.isArray(settings.packages) && settings.packages.some((p) => typeof p === "string" && /pi-subagents/.test(p));
	}

	/** Every agent the user can see: bundled ones, custom files, with edits and disabled flags applied. */
	async list(): Promise<AgentView[]> {
		const bundled = new Map<string, AgentDef>();
		for (const dir of await this.builtinDirs()) {
			for (const e of await this.readDir(dir)) if (!bundled.has(e.name)) bundled.set(e.name, defFromFile(e.name, e.parsed));
		}
		const custom = new Map<string, { def: AgentDef; file: string }>();
		for (const e of await this.readDir(this.userDir)) custom.set(e.name, { def: defFromFile(e.name, e.parsed), file: e.file });
		const { all } = await this.overrides();

		const views: AgentView[] = [];
		for (const name of new Set([...bundled.keys(), ...custom.keys()])) {
			const o = all[name];
			const mine = custom.get(name);
			const base = mine?.def ?? (bundled.get(name) as AgentDef);
			const def = applyOverride(base, o);
			const diffs = !mine && o ? Object.keys(diffOverride(base, def)).length > 0 : false;
			views.push({
				...def,
				source: mine ? "custom" : "builtin",
				shadows: Boolean(mine && bundled.has(name)),
				modified: diffs,
				disabled: o?.disabled === true,
				...(mine ? { file: mine.file } : {}),
			});
		}
		return views.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === "custom" ? -1 : 1));
	}

	async get(name: string): Promise<AgentView> {
		const hit = (await this.list()).find((a) => a.name === name);
		if (!hit) throw new Error("子代理不存在");
		return hit;
	}

	async create(name: string, draft: unknown): Promise<void> {
		if (!NAME_RE.test(name)) throw new Error("名称只能含小写字母、数字、- _ .，且以字母或数字开头");
		if ((await this.list()).some((a) => a.name === name)) throw new Error("已存在同名子代理");
		const def = sanitizeDef(draft, name);
		await mkdir(this.userDir, { recursive: true });
		await writeFile(join(this.userDir, `${name}.md`), serializeAgent(def));
	}

	async save(name: string, draft: unknown): Promise<void> {
		const current = await this.get(name);
		const def = sanitizeDef(draft, name);
		if (current.source === "custom" && current.file) {
			const prior = parseAgentFile(await readFile(current.file, "utf8"));
			await writeFile(current.file, serializeAgent(def, prior));
			// File fields win only when nothing overrides them; drop stale layers on the same agent.
			const { all } = await this.overrides();
			const o = all[name];
			if (o && OVERRIDE_KEYS.some((k) => k in o)) {
				const keep = Object.fromEntries(Object.entries(o).filter(([k]) => !(OVERRIDE_KEYS as readonly string[]).includes(k)));
				await this.writeOverride(name, keep);
			}
			return;
		}
		// Bundled agent: only what differs from the shipped definition is stored.
		const bundledBase = await this.bundledBase(name);
		const { all } = await this.overrides();
		const kept = Object.fromEntries(Object.entries(all[name] ?? {}).filter(([k]) => !(OVERRIDE_KEYS as readonly string[]).includes(k)));
		await this.writeOverride(name, { ...kept, ...diffOverride(bundledBase, def) });
	}

	private async bundledBase(name: string): Promise<AgentDef> {
		for (const dir of await this.builtinDirs()) {
			const hit = (await this.readDir(dir)).find((e) => e.name === name);
			if (hit) return defFromFile(name, hit.parsed);
		}
		throw new Error("找不到内置子代理的原始定义，请确认已安装 pi-subagents");
	}

	async setDisabled(name: string, disabled: boolean): Promise<void> {
		await this.get(name);
		const { all } = await this.overrides();
		const next = { ...(all[name] ?? {}) };
		if (disabled) next.disabled = true;
		else delete next.disabled;
		await this.writeOverride(name, next);
	}

	/** Bundled: drop the edits. Custom that shadows a bundled agent: delete the file so the original returns. */
	async reset(name: string): Promise<void> {
		const current = await this.get(name);
		if (current.source === "custom" && current.file) {
			if (!current.shadows) throw new Error("自定义子代理没有可恢复的内置版本，请使用删除");
			await rm(current.file, { force: true });
		}
		const { all } = await this.overrides();
		const keep = Object.fromEntries(Object.entries(all[name] ?? {}).filter(([k]) => k === "disabled"));
		await this.writeOverride(name, keep);
	}

	async remove(name: string): Promise<void> {
		const current = await this.get(name);
		if (current.source !== "custom" || !current.file) throw new Error("内置子代理不能删除，只能停用");
		await rm(current.file, { force: true });
		await this.writeOverride(name, undefined);
	}
}
