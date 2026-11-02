import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PERSONA = `你是用户的个人助理，不是某个项目的程序员。这里是你自己的家：用来回答问题、整理想法、规划事情、记笔记。

- 问答、规划、整理、记录：自己在这里办。想留下的内容写到 notes/ 里（一件事一个文件，文件名写清楚），已有的笔记先看一眼再写，别重复。
- 关于用户本人的长期事实（偏好、习惯、环境、目标）用 memory_save 记下来；工作用的材料才写 notes/。
- 需要看或改某个项目里的代码、文件、跑命令时：先用 assistant_projects 看有哪些项目，再用 assistant_delegate 把一个明确的任务派到那个项目里办，等结果回来再向用户汇报。不要自己去改项目里的文件。
- 派活时把任务写具体：要达成什么、范围多大、期望什么形式的结果。能只读就只读；只有用户明确要求改动才申请改文件。一件事涉及几个项目就分别派，别把无关的活塞进同一个任务。
- 你能派出的权限不会超过这个对话当前的权限模式。需要改文件但被降成只读时，如实告诉用户，请他切换权限模式后再来。
- 用户想让某件事定期自动做时，先说清楚打算怎么做，用户同意后再用 automation_create 建立。不要未经同意就创建定时任务。
- 用户想要每日简报时，用 assistant_briefing 开启（时间由用户定）；简报会存到 notes/ 里。
- 汇报先说结论，简短；做不了或被拒绝的事如实说明，不要假装办成。
`;

export interface Home {
	dir: string;
	notes: string;
	persona: string;
}

/** The assistant's own folder: persona.md (the user may edit it) and notes/. Nothing existing is overwritten. */
export function ensureHome(dataDir: string): Home {
	const dir = join(dataDir, "home");
	const notes = join(dir, "notes");
	mkdirSync(notes, { recursive: true });
	const persona = join(dir, "persona.md");
	if (!existsSync(persona)) writeFileSync(persona, PERSONA);
	return { dir, notes, persona };
}

const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();

export function sameDir(a: string | undefined, b: string | undefined): boolean {
	return Boolean(a) && Boolean(b) && norm(a!) === norm(b!);
}

/** The persona text, capped; empty when the file is missing or blank. */
export function readPersona(home: Home): string {
	try {
		return readFileSync(home.persona, "utf8").trim().slice(0, 6000);
	} catch {
		return "";
	}
}

export interface NoteInfo {
	name: string;
	modified: number;
	size: number;
}

/** Newest first; only plain files directly in notes/. */
export function listNotes(home: Home, limit = 30): NoteInfo[] {
	let names: string[];
	try {
		names = readdirSync(home.notes);
	} catch {
		return [];
	}
	const out: NoteInfo[] = [];
	for (const name of names) {
		try {
			const st = statSync(join(home.notes, name));
			if (st.isFile()) out.push({ name, modified: st.mtimeMs, size: st.size });
		} catch {
			// vanished between listing and stat
		}
	}
	return out.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

/** A short index of the notes so the assistant knows what it already wrote without reading every file. */
export function notesIndex(notes: NoteInfo[]): string {
	if (!notes.length) return "";
	const lines = notes.map((n) => `- ${n.name} (${new Date(n.modified).toISOString().slice(0, 10)})`);
	return `notes/ 里已有的笔记（最近的在前，需要时再读）：\n${lines.join("\n")}`;
}
