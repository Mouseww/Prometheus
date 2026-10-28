// Syntax colouring for the side file viewer. highlight.js is already in the bundle (rehype-highlight uses the same
// grammars for chat code blocks), so this adds no weight. The viewer shows numbered lines, so the highlighted HTML is
// cut into lines with every open <span> closed at the end of a line and reopened on the next.
import hljs from "highlight.js/lib/common";

/** Past this size colouring a file costs more than it is worth; it is shown plain. */
const MAX_CHARS = 300_000;

/** File extension -> highlight.js language (only languages in highlight.js' common set). */
const BY_EXT: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", jsonc: "json", json5: "json",
	md: "markdown", markdown: "markdown",
	py: "python", pyi: "python", rb: "ruby", php: "php", pl: "perl", lua: "lua", r: "r",
	rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", scala: "scala",
	c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp", m: "objectivec",
	css: "css", scss: "scss", sass: "scss", less: "less",
	html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", xaml: "xml", csproj: "xml", plist: "xml",
	yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "bash",
	sh: "bash", bash: "bash", zsh: "bash", sql: "sql", graphql: "graphql", gql: "graphql",
	diff: "diff", patch: "diff", makefile: "makefile", mk: "makefile", wasm: "wasm", vb: "vbnet",
};

/** Server-side language names (WorkbenchFile.language) that differ from highlight.js'. */
const ALIAS: Record<string, string> = { html: "xml", toml: "ini", shell: "bash" };

/** The highlight.js language for a file, or null when it has none (plain text, unknown, or not bundled). */
export function languageFor(name: string, serverLanguage?: string): string | null {
	const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
	const ext = base === "makefile" || base === "dockerfile" ? base : base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
	const lang = BY_EXT[ext] ?? serverAlias(serverLanguage);
	if (!lang || lang === "text" || lang === "plaintext") return null;
	return hljs.getLanguage(lang) ? lang : null;
}

const TAG = /<span class="[^"]*">|<\/span>/g;

/** Cut highlighted HTML into lines, each with balanced spans. */
export function splitHighlighted(html: string): string[] {
	const out: string[] = [];
	const open: string[] = [];
	for (const raw of html.split("\n")) {
		const line = open.join("") + raw;
		TAG.lastIndex = 0;
		for (const m of raw.matchAll(TAG)) {
			if (m[0] === "</span>") open.pop();
			else open.push(m[0]);
		}
		out.push(line + "</span>".repeat(open.length));
	}
	return out;
}

/** Highlighted HTML per line (escaped by highlight.js, safe to inject), or null to show the text plain. */
export function highlightLines(text: string, language: string | null): string[] | null {
	if (!language || text.length > MAX_CHARS) return null;
	try {
		return splitHighlighted(hljs.highlight(text, { language, ignoreIllegals: true }).value);
	} catch {
		return null;
	}
}

function serverAlias(language: string | undefined): string | undefined {
	if (!language) return undefined;
	return ALIAS[language] ?? language;
}
