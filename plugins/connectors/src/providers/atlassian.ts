import { Type } from "@earendil-works/pi-ai";
import { request } from "../http.ts";
import type { ConnectorProvider, OperationContext } from "../types.ts";

/** Atlassian Cloud with email + API token (https://id.atlassian.com/manage-profile/security/api-tokens). */
function site(c: OperationContext): string {
	const s = c.credentials.config.site ?? "";
	if (!/^[a-z0-9-]+(\.atlassian\.net)?$/i.test(s)) throw new Error("站点应形如 your-team 或 your-team.atlassian.net");
	return `https://${s.includes(".") ? s : `${s}.atlassian.net`}`;
}

function call<T>(c: OperationContext, path: string, opts: Parameters<typeof request>[1] = {}) {
	const basic = Buffer.from(`${c.credentials.config.email}:${c.credentials.token}`).toString("base64");
	return request<T>(`${site(c)}${path}`, { ...opts, signal: c.signal, headers: { authorization: `Basic ${basic}`, ...opts.headers } });
}

const key = Type.String({ description: "Issue key，如 PROJ-123", pattern: "^[A-Z][A-Z0-9_]+-\\d+$" });

/** Jira Cloud v3 stores rich text as Atlassian Document Format. */
export function adf(text: string) {
	return { type: "doc", version: 1, content: text.split(/\n{2,}/).map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })) };
}

export function flattenAdf(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const n = node as { text?: string; type?: string; content?: unknown[] };
	const inner = (n.content ?? []).map(flattenAdf).join(n.type === "doc" ? "\n\n" : "");
	return (n.text ?? "") + inner;
}

interface JiraIssue {
	key: string;
	fields: { summary: string; status?: { name: string }; assignee?: { displayName: string } | null; issuetype?: { name: string }; description?: unknown; priority?: { name: string } | null };
}

const slim = (i: JiraIssue, full = false) => ({
	key: i.key,
	summary: i.fields.summary,
	status: i.fields.status?.name,
	type: i.fields.issuetype?.name,
	assignee: i.fields.assignee?.displayName,
	priority: i.fields.priority?.name,
	...(full ? { description: flattenAdf(i.fields.description) } : {}),
});

export const atlassian: ConnectorProvider = {
	id: "atlassian",
	name: "Atlassian (Jira / Confluence)",
	category: "issues",
	description: "Jira Cloud 的 Issue 搜索与流转，Confluence 页面搜索与阅读",
	auth: [{ kind: "basic", help: "邮箱 + API Token（https://id.atlassian.com/manage-profile/security/api-tokens）" }],
	fields: {
		basic: [
			{ key: "site", label: "站点", required: true, placeholder: "your-team.atlassian.net" },
			{ key: "email", label: "账户邮箱", required: true },
			{ key: "token", label: "API Token", secret: true, required: true },
		],
	},
	async test(c) {
		return (await call<{ displayName: string }>(c, "/rest/api/3/myself")).displayName;
	},
	operations: [
		{
			name: "jira_search",
			description: "用 JQL 搜索 Jira Issue",
			access: "read",
			params: Type.Object({ jql: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
			async run(p, c) {
				const r = await call<{ issues: JiraIssue[] }>(c, "/rest/api/3/search/jql", { query: { jql: String(p.jql), maxResults: Number(p.limit ?? 20), fields: "summary,status,assignee,issuetype,priority" } });
				return r.issues.map((i) => slim(i));
			},
		},
		{
			name: "jira_get",
			description: "查看 Jira Issue 详情",
			access: "read",
			params: Type.Object({ key }),
			async run(p, c) {
				return slim(await call<JiraIssue>(c, `/rest/api/3/issue/${String(p.key)}`), true);
			},
		},
		{
			name: "jira_create",
			description: "创建 Jira Issue",
			access: "write",
			params: Type.Object({ project: Type.String({ description: "项目 key" }), summary: Type.String(), description: Type.Optional(Type.String()), type: Type.Optional(Type.String({ description: "默认 Task" })) }),
			async run(p, c) {
				const r = await call<{ key: string }>(c, "/rest/api/3/issue", {
					method: "POST",
					json: { fields: { project: { key: p.project }, summary: p.summary, issuetype: { name: p.type || "Task" }, ...(p.description ? { description: adf(String(p.description)) } : {}) } },
				});
				return { key: r.key, url: `${site(c)}/browse/${r.key}` };
			},
		},
		{
			name: "jira_comment",
			description: "给 Jira Issue 添加评论",
			access: "write",
			params: Type.Object({ key, body: Type.String() }),
			async run(p, c) {
				await call(c, `/rest/api/3/issue/${String(p.key)}/comment`, { method: "POST", json: { body: adf(String(p.body)) } });
				return { ok: true };
			},
		},
		{
			name: "jira_transition",
			description: "流转 Issue 状态（name 为目标状态名，如 Done；不匹配时返回可用流转）",
			access: "write",
			params: Type.Object({ key, name: Type.String() }),
			async run(p, c) {
				const { transitions } = await call<{ transitions: { id: string; name: string }[] }>(c, `/rest/api/3/issue/${String(p.key)}/transitions`);
				const hit = transitions.find((t) => t.name.toLowerCase() === String(p.name).toLowerCase());
				if (!hit) throw new Error(`没有名为 ${String(p.name)} 的流转，可用：${transitions.map((t) => t.name).join(", ")}`);
				await call(c, `/rest/api/3/issue/${String(p.key)}/transitions`, { method: "POST", json: { transition: { id: hit.id } } });
				return { ok: true, to: hit.name };
			},
		},
		{
			name: "confluence_search",
			description: "用 CQL 或关键词搜索 Confluence 页面",
			access: "read",
			params: Type.Object({ query: Type.String({ description: "关键词，或以 CQL 书写" }) }),
			async run(p, c) {
				const q = String(p.query);
				const cql = /[=~]/.test(q) ? q : `text ~ "${q.replace(/"/g, '\\"')}" AND type = page`;
				const r = await call<{ results: { content?: { id: string; title: string }; excerpt?: string }[] }>(c, "/wiki/rest/api/search", { query: { cql, limit: 15 } });
				return r.results.filter((x) => x.content).map((x) => ({ id: x.content?.id, title: x.content?.title, excerpt: x.excerpt }));
			},
		},
		{
			name: "confluence_get",
			description: "读取 Confluence 页面正文（纯文本化）",
			access: "read",
			params: Type.Object({ id: Type.String({ pattern: "^\\d+$" }) }),
			async run(p, c) {
				const r = await call<{ title: string; body: { storage: { value: string } } }>(c, `/wiki/rest/api/content/${String(p.id)}`, { query: { expand: "body.storage" } });
				return { title: r.title, text: r.body.storage.value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
			},
		},
	],
};
