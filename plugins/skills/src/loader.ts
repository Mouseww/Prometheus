// Finds and reads SKILL.md files without the PI packages (their loader is optional now). Same discovery rules as PI's:
// a folder holding SKILL.md is one skill and is not searched further; otherwise the root's own .md files count, and
// subfolders are searched for SKILL.md.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
}

function unquote(v: string): string {
	const t = v.trim();
	if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
		try {
			return JSON.parse(t) as string;
		} catch {
			return t.slice(1, -1);
		}
	}
	if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
	return t;
}

/** The few YAML shapes skill frontmatter uses: `key: value`, quoted values, and `|` / `>` blocks. */
export function parseFrontmatter(text: string): Record<string, string> {
	const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m?.[1]) return {};
	const out: Record<string, string> = {};
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? "");
		if (!kv?.[1]) continue;
		const key = kv[1];
		const rest = kv[2] ?? "";
		if (/^[|>][+-]?$/.test(rest.trim())) {
			const block: string[] = [];
			while (i + 1 < lines.length && /^(\s+|$)/.test(lines[i + 1] ?? "")) block.push((lines[++i] ?? "").trim());
			out[key] = block.join(rest.trim().startsWith("|") ? "\n" : " ").trim();
		} else {
			out[key] = unquote(rest);
		}
	}
	return out;
}

function readSkill(file: string, fallbackName: string): Skill | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const fm = parseFrontmatter(text);
	const description = fm.description?.trim();
	if (!description) return undefined;
	return {
		name: fm.name?.trim() || fallbackName,
		description,
		filePath: file,
		baseDir: dirname(file),
		disableModelInvocation: fm["disable-model-invocation"] === "true",
	};
}

function walk(dir: string, root: boolean, out: Skill[]): void {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	if (entries.some((e) => e.name === "SKILL.md")) {
		const skill = readSkill(join(dir, "SKILL.md"), basename(dir));
		if (skill) out.push(skill);
		return;
	}
	for (const e of entries) {
		if (e.name.startsWith(".") || e.name === "node_modules") continue;
		const full = join(dir, e.name);
		let isDir = e.isDirectory();
		let isFile = e.isFile();
		if (e.isSymbolicLink()) {
			try {
				const st = statSync(full);
				isDir = st.isDirectory();
				isFile = st.isFile();
			} catch {
				continue;
			}
		}
		if (isDir) walk(full, false, out);
		else if (root && isFile && e.name.toLowerCase().endsWith(".md")) {
			const skill = readSkill(full, e.name.replace(/\.md$/i, ""));
			if (skill) out.push(skill);
		}
	}
}

export function loadSkillsFromDir(opts: { dir: string }): { skills: Skill[] } {
	const skills: Skill[] = [];
	if (existsSync(opts.dir)) walk(opts.dir, true, skills);
	return { skills };
}
