import { Type } from "@earendil-works/pi-ai";
import { request } from "../http.ts";
import type { ConnectorProvider, OperationContext } from "../types.ts";

const API = "https://api.bitbucket.org/2.0";

function bb<T>(c: OperationContext, path: string, opts: Parameters<typeof request>[1] = {}) {
	const { token, config } = c.credentials;
	const authorization = config.username ? `Basic ${Buffer.from(`${config.username}:${token}`).toString("base64")}` : `Bearer ${token}`;
	return request<T>(`${API}${path}`, { ...opts, signal: c.signal, headers: { authorization, ...opts.headers } });
}

const slug = Type.String({ pattern: "^[\\w.-]+$" });
const e = (v: unknown) => encodeURIComponent(String(v));

interface Pr {
	id: number;
	title: string;
	state: string;
	author?: { display_name: string };
	source?: { branch: { name: string } };
	destination?: { branch: { name: string } };
	links?: { html: { href: string } };
	description?: string;
}

const slimPr = (p: Pr, full = false) => ({
	id: p.id,
	title: p.title,
	state: p.state,
	author: p.author?.display_name,
	from: p.source?.branch.name,
	to: p.destination?.branch.name,
	url: p.links?.html.href,
	...(full ? { description: p.description } : {}),
});

export const bitbucket: ConnectorProvider = {
	id: "bitbucket",
	name: "Bitbucket Cloud",
	category: "code",
	description: "Bitbucket 仓库与 Pull Request",
	auth: [
		{ kind: "token", label: "Repository / Workspace Access Token", help: "Bitbucket → Repository settings → Access tokens" },
		{ kind: "basic", help: "用户名 + App Password" },
	],
	fields: {
		token: [],
		basic: [
			{ key: "username", label: "用户名", required: true },
			{ key: "token", label: "App Password", secret: true, required: true },
		],
	},
	async test(c) {
		if (c.credentials.config.username) return (await bb<{ display_name: string }>(c, "/user")).display_name;
		// Scoped access tokens cannot read /user; a workspace listing proves the token is accepted.
		const r = await bb<{ values: { slug: string }[] }>(c, "/workspaces", { query: { pagelen: 1 } }).catch(() => undefined);
		return r?.values[0]?.slug ?? "access-token";
	},
	operations: [
		{
			name: "list_repos",
			description: "列出工作区下的仓库",
			access: "read",
			params: Type.Object({ workspace: slug }),
			async run(p, c) {
				const r = await bb<{ values: { full_name: string; is_private: boolean; description: string; links: { html: { href: string } } }[] }>(c, `/repositories/${e(p.workspace)}`, { query: { pagelen: 50, sort: "-updated_on" } });
				return r.values.map((v) => ({ name: v.full_name, private: v.is_private, description: v.description, url: v.links.html.href }));
			},
		},
		{
			name: "list_pulls",
			description: "列出仓库的 Pull Request",
			access: "read",
			params: Type.Object({ workspace: slug, repo: slug, state: Type.Optional(Type.Union([Type.Literal("OPEN"), Type.Literal("MERGED"), Type.Literal("DECLINED")])) }),
			async run(p, c) {
				const r = await bb<{ values: Pr[] }>(c, `/repositories/${e(p.workspace)}/${e(p.repo)}/pullrequests`, { query: { state: String(p.state ?? "OPEN"), pagelen: 30 } });
				return r.values.map((v) => slimPr(v));
			},
		},
		{
			name: "get_pull",
			description: "查看 Pull Request 详情",
			access: "read",
			params: Type.Object({ workspace: slug, repo: slug, id: Type.Integer() }),
			async run(p, c) {
				return slimPr(await bb<Pr>(c, `/repositories/${e(p.workspace)}/${e(p.repo)}/pullrequests/${Number(p.id)}`), true);
			},
		},
		{
			name: "pull_diff",
			description: "获取 Pull Request 的 diff 文本",
			access: "read",
			params: Type.Object({ workspace: slug, repo: slug, id: Type.Integer() }),
			async run(p, c) {
				return bb<string>(c, `/repositories/${e(p.workspace)}/${e(p.repo)}/pullrequests/${Number(p.id)}/diff`, { headers: { accept: "text/plain" } });
			},
		},
		{
			name: "comment_pull",
			description: "在 Pull Request 上评论",
			access: "write",
			params: Type.Object({ workspace: slug, repo: slug, id: Type.Integer(), body: Type.String() }),
			async run(p, c) {
				await bb(c, `/repositories/${e(p.workspace)}/${e(p.repo)}/pullrequests/${Number(p.id)}/comments`, { method: "POST", json: { content: { raw: p.body } } });
				return { ok: true };
			},
		},
	],
};
