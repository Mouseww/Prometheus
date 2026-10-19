import { Type } from "@earendil-works/pi-ai";
import { request } from "../http.ts";
import type { ConnectorProvider, OperationContext } from "../types.ts";

const base = (c: OperationContext) => (c.credentials.config.apiUrl || "https://api.github.com").replace(/\/+$/, "");

function gh<T>(c: OperationContext, path: string, opts: Parameters<typeof request>[1] = {}) {
	return request<T>(`${base(c)}${path}`, {
		...opts,
		signal: c.signal,
		headers: { authorization: `Bearer ${c.credentials.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...opts.headers },
	});
}

const repoParam = Type.String({ description: "owner/name", pattern: "^[\\w.-]+/[\\w.-]+$" });
const str = (v: unknown) => String(v ?? "");

interface Issue {
	number: number;
	title: string;
	state: string;
	user?: { login: string };
	html_url: string;
	body?: string | null;
	labels?: { name: string }[];
	pull_request?: unknown;
}
const slim = (i: Issue, withBody = false) => ({ number: i.number, title: i.title, state: i.state, author: i.user?.login, url: i.html_url, labels: i.labels?.map((l) => l.name), ...(withBody ? { body: i.body } : {}) });

export const github: ConnectorProvider = {
	id: "github",
	name: "GitHub",
	category: "code",
	description: "仓库、Issue、Pull Request 与代码搜索（支持 GitHub Enterprise）",
	auth: [
		{ kind: "oauth-device", deviceUrl: "https://github.com/login/device/code", tokenUrl: "https://github.com/login/oauth/access_token", scopes: ["repo", "read:org"], help: "点击后会得到一个验证码，在 GitHub 页面输入并授权即可，无需手动创建令牌" },
		{
			kind: "oauth-code",
			authorizeUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
			scopes: ["repo", "read:org"],
			help: "在 GitHub → Settings → Developer settings → OAuth Apps 创建应用，把下方回调地址填进 Authorization callback URL",
		},
		{ kind: "token", label: "Personal Access Token", help: "在 GitHub → Settings → Developer settings 创建（建议 fine-grained，仅授予所需仓库）" },
	],
	builtinClientIds: { "oauth-device": "Ov23liJbBhU83HnyA7Rs" },
	fields: {
		token: [{ key: "apiUrl", label: "API 地址（可选）", placeholder: "https://api.github.com", help: "GitHub Enterprise 填 https://host/api/v3" }],
		"oauth-app": [
			{ key: "clientId", label: "Client ID", required: true },
			{ key: "clientSecret", label: "Client Secret", secret: true, required: true },
		],
	},
	async test(c) {
		return (await gh<{ login: string }>(c, "/user")).login;
	},
	operations: [
		{
			name: "list_repos",
			description: "列出当前账户可访问的仓库（按最近更新）",
			access: "read",
			params: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
			async run(p, c) {
				const repos = await gh<{ full_name: string; private: boolean; description: string | null; html_url: string }[]>(c, "/user/repos", { query: { sort: "updated", per_page: Number(p.limit ?? 30) } });
				return repos.map((r) => ({ name: r.full_name, private: r.private, description: r.description, url: r.html_url }));
			},
		},
		{
			name: "list_issues",
			description: "列出仓库 Issue（不含 PR）",
			access: "read",
			params: Type.Object({ repo: repoParam, state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
			async run(p, c) {
				const items = await gh<Issue[]>(c, `/repos/${str(p.repo)}/issues`, { query: { state: str(p.state || "open"), per_page: Number(p.limit ?? 30) } });
				return items.filter((i) => !i.pull_request).map((i) => slim(i));
			},
		},
		{
			name: "get_issue",
			description: "查看 Issue 或 PR 的详情与正文",
			access: "read",
			params: Type.Object({ repo: repoParam, number: Type.Integer() }),
			async run(p, c) {
				return slim(await gh<Issue>(c, `/repos/${str(p.repo)}/issues/${Number(p.number)}`), true);
			},
		},
		{
			name: "list_pulls",
			description: "列出仓库 Pull Request",
			access: "read",
			params: Type.Object({ repo: repoParam, state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")])) }),
			async run(p, c) {
				const items = await gh<(Issue & { head: { ref: string }; base: { ref: string } })[]>(c, `/repos/${str(p.repo)}/pulls`, { query: { state: str(p.state || "open"), per_page: 30 } });
				return items.map((i) => ({ ...slim(i), head: i.head.ref, base: i.base.ref }));
			},
		},
		{
			name: "get_file",
			description: "读取仓库中的文件内容",
			access: "read",
			params: Type.Object({ repo: repoParam, path: Type.String(), ref: Type.Optional(Type.String()) }),
			async run(p, c) {
				const f = await gh<{ content?: string; encoding?: string; type: string }>(c, `/repos/${str(p.repo)}/contents/${str(p.path).split("/").map(encodeURIComponent).join("/")}`, { query: { ref: p.ref ? str(p.ref) : undefined } });
				if (f.type !== "file" || !f.content) throw new Error("该路径不是文件");
				return Buffer.from(f.content, "base64").toString("utf8");
			},
		},
		{
			name: "search_code",
			description: "在 GitHub 搜索代码（q 支持 repo:、language: 等限定符）",
			access: "read",
			params: Type.Object({ q: Type.String() }),
			async run(p, c) {
				const r = await gh<{ items: { name: string; path: string; html_url: string; repository: { full_name: string } }[] }>(c, "/search/code", { query: { q: str(p.q), per_page: 20 } });
				return r.items.map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url }));
			},
		},
		{
			name: "create_issue",
			description: "创建 Issue",
			access: "write",
			params: Type.Object({ repo: repoParam, title: Type.String(), body: Type.Optional(Type.String()), labels: Type.Optional(Type.Array(Type.String())) }),
			async run(p, c) {
				return slim(await gh<Issue>(c, `/repos/${str(p.repo)}/issues`, { method: "POST", json: { title: p.title, body: p.body, labels: p.labels } }));
			},
		},
		{
			name: "comment",
			description: "在 Issue 或 PR 上评论",
			access: "write",
			params: Type.Object({ repo: repoParam, number: Type.Integer(), body: Type.String() }),
			async run(p, c) {
				const r = await gh<{ html_url: string }>(c, `/repos/${str(p.repo)}/issues/${Number(p.number)}/comments`, { method: "POST", json: { body: p.body } });
				return { url: r.html_url };
			},
		},
	],
};
