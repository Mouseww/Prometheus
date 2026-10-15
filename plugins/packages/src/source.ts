const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9._~^<>=|*+-]+)?$/i;
const GIT_SPEC = /^(?:git:|https:\/\/)[a-z0-9][a-z0-9.-]*\/[\w.~/-]+(?:@[\w.~/-]+)?$/i;
const MAX_SOURCE = 300;

/**
 * Turn user input into a PI package source (`npm:` or `git:`/https). Local paths and anything that could be
 * read as a command-line option are refused: installing runs third-party code, so the accepted surface stays small.
 */
export function normalizeSource(input: unknown): string {
	const raw = typeof input === "string" ? input.trim() : "";
	if (!raw) throw new Error("请填写包名或来源");
	if (raw.length > MAX_SOURCE) throw new Error("来源过长");

	if (raw.startsWith("npm:")) {
		if (!NPM_SPEC.test(raw.slice(4))) throw new Error("npm 包名不合法");
		return raw;
	}
	if (raw.startsWith("git:") || raw.startsWith("https://")) {
		if (!GIT_SPEC.test(raw) || raw.split("/").includes("..")) throw new Error("git 来源不合法，示例：git:github.com/owner/repo@v1");
		return raw;
	}
	if (NPM_SPEC.test(raw)) return `npm:${raw}`;
	throw new Error("仅支持 npm 包名（npm:pkg@1.0.0）或 git 地址（git:github.com/owner/repo）");
}

/** Package name inside an `npm:` source, without version; undefined for other source kinds. */
export function npmNameOf(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4);
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}
