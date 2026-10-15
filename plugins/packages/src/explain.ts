const RULES: [RegExp, string][] = [
	[/spawn \S+ ENOENT|not recognized as an internal|command not found/i, "找不到 npm 或 git 命令，请安装 Node.js（含 npm）/ Git，并确保它们在 PATH 中"],
	[/\bE404\b|404 Not Found|is not in this registry/i, "在 registry 中找不到该包，请检查包名与版本"],
	[/\bETARGET\b|notarget|No matching version/i, "找不到匹配的版本"],
	[/publickey|Authentication failed|could not read Username/i, "git 仓库需要认证，无法匿名拉取"],
	[/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|getaddrinfo|Could not resolve host|unable to access|network/i, "无法访问 registry 或 git 仓库，请检查网络或代理后重试"],
	[/EACCES|EPERM|permission denied/i, "没有写入权限，请检查 PI 配置目录（~/.pi/agent）的权限"],
	[/超时/, "执行超时"],
];

const NPM_NOISE = /A complete log|Log files were|For a full report|debug-0\.log|npm notice|npm warn/i;
const MAX_REASON = 300;

/** Turn a failed install into a short reason: a recognised cause when possible, plus the last npm error line. */
export function explainFailure(err: unknown, log: string[]): string {
	const message = err instanceof Error ? err.message : String(err);
	const haystack = `${log.join("\n")}\n${message}`;

	const detail =
		[...log]
			.reverse()
			.map((l) => /^npm (?:error|ERR!)\s*(.*)$/i.exec(l)?.[1]?.trim())
			.find((l): l is string => Boolean(l) && !NPM_NOISE.test(l ?? "")) ??
		[...log].reverse().find((l) => !l.startsWith("$") && l.trim()) ??
		message;

	const hint = RULES.find(([re]) => re.test(haystack))?.[1];
	const text = hint ? (detail && !hint.includes(detail) && detail !== message ? `${hint}（${detail}）` : hint) : detail;
	return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
}
