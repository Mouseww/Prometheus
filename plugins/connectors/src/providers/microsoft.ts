import { Type } from "@earendil-works/pi-ai";
import { request } from "../http.ts";
import type { ConnectorProvider, OperationContext } from "../types.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

function graph<T>(c: OperationContext, path: string, opts: Parameters<typeof request>[1] = {}) {
	return request<T>(`${GRAPH}${path}`, { ...opts, signal: c.signal, headers: { authorization: `Bearer ${c.credentials.token}`, ...opts.headers } });
}

const id = Type.String({ pattern: "^[\\w=+/.:@!-]+$", description: "Graph 对象 id" });
const e = (v: unknown) => encodeURIComponent(String(v));

interface Mail {
	id: string;
	subject?: string;
	from?: { emailAddress: { name?: string; address: string } };
	receivedDateTime?: string;
	bodyPreview?: string;
	isRead?: boolean;
	body?: { contentType: string; content: string };
}

const slimMail = (m: Mail) => ({ id: m.id, subject: m.subject, from: m.from?.emailAddress.address, received: m.receivedDateTime, unread: m.isRead === false, preview: m.bodyPreview });

export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const recipients = (list: unknown) => (Array.isArray(list) ? list : []).map((a) => ({ emailAddress: { address: String(a) } }));

export const microsoft: ConnectorProvider = {
	id: "microsoft",
	name: "Microsoft 365 (Outlook / Teams / OneDrive)",
	category: "mail",
	description: "通过 Microsoft Graph 访问 Outlook 邮件与日历、Teams 频道、OneDrive 文件",
	auth: [
		{
			kind: "oauth-device",
			deviceUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode",
			tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
			scopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.Read", "Team.ReadBasic.All", "Channel.ReadBasic.All", "ChannelMessage.Send", "Files.Read.All"],
			help: "在 Microsoft Entra 注册应用：公共客户端，启用「允许公共客户端流」，并授予上述委托权限",
		},
		{ kind: "token", label: "Graph Access Token（临时）", help: "例如从 Graph Explorer 复制，约 1 小时过期，仅用于试用" },
	],
	fields: {
		"oauth-app": [
			{ key: "clientId", label: "Application (client) ID", required: true },
			{ key: "tenant", label: "Tenant", placeholder: "organizations 或租户 ID / 域名", help: "默认 organizations；个人账号用 consumers" },
		],
		token: [],
	},
	async test(c) {
		const me = await graph<{ displayName: string; userPrincipalName: string }>(c, "/me");
		return me.userPrincipalName || me.displayName;
	},
	operations: [
		{
			name: "mail_list",
			description: "列出收件箱（或指定文件夹）最近邮件；search 用于关键词搜索",
			access: "read",
			params: Type.Object({ folder: Type.Optional(Type.String({ description: "inbox / sentitems / drafts，默认 inbox" })), search: Type.Optional(Type.String()), unreadOnly: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
			async run(p, c) {
				const query: Record<string, string | number> = { $top: Number(p.limit ?? 15), $select: "id,subject,from,receivedDateTime,bodyPreview,isRead" };
				if (p.search) query.$search = `"${String(p.search).replace(/"/g, "")}"`;
				else query.$orderby = "receivedDateTime desc";
				if (p.unreadOnly && !p.search) query.$filter = "isRead eq false";
				const r = await graph<{ value: Mail[] }>(c, `/me/mailFolders/${e(p.folder || "inbox")}/messages`, { query });
				return r.value.map(slimMail);
			},
		},
		{
			name: "mail_get",
			description: "读取一封邮件正文（纯文本）",
			access: "read",
			params: Type.Object({ id }),
			async run(p, c) {
				const m = await graph<Mail>(c, `/me/messages/${e(p.id)}`, { query: { $select: "id,subject,from,receivedDateTime,body" } });
				const body = m.body?.contentType === "html" ? htmlToText(m.body.content) : (m.body?.content ?? "");
				return { ...slimMail(m), body };
			},
		},
		{
			name: "mail_send",
			description: "发送邮件",
			access: "write",
			params: Type.Object({ to: Type.Array(Type.String()), subject: Type.String(), body: Type.String(), cc: Type.Optional(Type.Array(Type.String())) }),
			async run(p, c) {
				await graph(c, "/me/sendMail", { method: "POST", json: { message: { subject: p.subject, body: { contentType: "Text", content: p.body }, toRecipients: recipients(p.to), ccRecipients: recipients(p.cc) } } });
				return { ok: true };
			},
		},
		{
			name: "calendar_list",
			description: "列出时间范围内的日历事件（ISO 时间）",
			access: "read",
			params: Type.Object({ start: Type.String({ description: "ISO 时间，如 2026-05-01T00:00:00Z" }), end: Type.String() }),
			async run(p, c) {
				const r = await graph<{ value: { subject: string; start: { dateTime: string }; end: { dateTime: string }; location?: { displayName: string }; organizer?: { emailAddress: { address: string } } }[] }>(c, "/me/calendarView", {
					query: { startDateTime: String(p.start), endDateTime: String(p.end), $top: 50, $orderby: "start/dateTime", $select: "subject,start,end,location,organizer" },
				});
				return r.value.map((v) => ({ subject: v.subject, start: v.start.dateTime, end: v.end.dateTime, location: v.location?.displayName, organizer: v.organizer?.emailAddress.address }));
			},
		},
		{
			name: "teams_list",
			description: "列出我加入的 Teams",
			access: "read",
			params: Type.Object({}),
			async run(_p, c) {
				const r = await graph<{ value: { id: string; displayName: string }[] }>(c, "/me/joinedTeams");
				return r.value.map((t) => ({ id: t.id, name: t.displayName }));
			},
		},
		{
			name: "channels_list",
			description: "列出某个 Team 的频道",
			access: "read",
			params: Type.Object({ team: id }),
			async run(p, c) {
				const r = await graph<{ value: { id: string; displayName: string }[] }>(c, `/teams/${e(p.team)}/channels`);
				return r.value.map((t) => ({ id: t.id, name: t.displayName }));
			},
		},
		{
			name: "channel_post",
			description: "向 Teams 频道发送消息",
			access: "write",
			params: Type.Object({ team: id, channel: id, text: Type.String() }),
			async run(p, c) {
				const r = await graph<{ id: string; webUrl?: string }>(c, `/teams/${e(p.team)}/channels/${e(p.channel)}/messages`, { method: "POST", json: { body: { contentType: "text", content: p.text } } });
				return { id: r.id, url: r.webUrl };
			},
		},
		{
			name: "files_search",
			description: "在 OneDrive 中搜索文件",
			access: "read",
			params: Type.Object({ query: Type.String() }),
			async run(p, c) {
				const r = await graph<{ value: { id: string; name: string; webUrl: string; size?: number; lastModifiedDateTime?: string }[] }>(c, `/me/drive/root/search(q='${String(p.query).replace(/'/g, "''")}')`, { query: { $top: 20, $select: "id,name,webUrl,size,lastModifiedDateTime" } });
				return r.value.map((f) => ({ id: f.id, name: f.name, url: f.webUrl, size: f.size, modified: f.lastModifiedDateTime }));
			},
		},
	],
};
