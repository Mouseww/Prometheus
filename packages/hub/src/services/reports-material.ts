import type { Queryable } from "../db/db.ts";
import { toIso } from "../db/db.ts";

export interface SessionMaterial {
	sessionId: string;
	title: string;
	ownerId: string;
	firstMessage: string | null;
	lastAssistantParagraph: string | null;
	toolCalls: number;
}

export interface MergeRequestMaterial {
	id: string;
	title: string;
	authorId: string;
	status: string;
	/** What happened to it during the report day. */
	happened: ("created" | "merged" | "rejected" | "conflict")[];
}

export interface ReportMaterial {
	date: string;
	sessions: SessionMaterial[];
	mergeRequests: MergeRequestMaterial[];
	names: Record<string, string>;
}

export interface ReportContent {
	date: string;
	overall: string[];
	risks: string[];
	members: { userId: string; name: string; items: string[] }[];
}

const SNIPPET_CHARS = 200;

export const snippet = (text: string, max = SNIPPET_CHARS): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

/** Text of a mirrored `message_end` payload (`{message:{role, content: string | [{type:"text", text}]}}`); defensive about shape. */
export function messageText(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) return "";
	const message = (payload as { message?: unknown }).message;
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
		.filter(Boolean)
		.join("\n");
}

const lastParagraph = (text: string): string | null => {
	const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
	return parts.length > 0 ? (parts[parts.length - 1] as string) : null;
};

/** Reads everything a day's report is built from (spec section 7). `[start, end)` are UTC instants. */
export async function collectMaterial(q: Queryable, workspaceId: string, date: string, start: Date, end: Date): Promise<ReportMaterial> {
	const range = [start.toISOString(), end.toISOString()];
	const active = await q.query<{ id: string; title: string; owner_user_id: string }>(
		`SELECT s.id, s.title, s.owner_user_id FROM sessions s
		 WHERE s.workspace_id = $1 AND ((s.last_activity_at >= $2::timestamptz AND s.last_activity_at < $3::timestamptz)
		   OR EXISTS (SELECT 1 FROM session_events e WHERE e.session_id = s.id AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz))
		 ORDER BY s.created_at, s.id`,
		[workspaceId, ...range],
	);

	const sessions: SessionMaterial[] = [];
	for (const s of active) {
		const tools = await q.query<{ n: string | number }>(
			"SELECT count(*) AS n FROM session_events WHERE session_id = $1 AND kind = 'tool_execution_start' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz",
			[s.id, ...range],
		);
		const first = await q.query<{ payload: unknown }>(
			"SELECT payload FROM session_events WHERE session_id = $1 AND kind = 'message_end' AND payload->'message'->>'role' = 'user' ORDER BY seq LIMIT 1",
			[s.id],
		);
		const last = await q.query<{ payload: unknown }>(
			`SELECT payload FROM session_events WHERE session_id = $1 AND kind = 'message_end' AND payload->'message'->>'role' = 'assistant'
			 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz ORDER BY seq DESC LIMIT 1`,
			[s.id, ...range],
		);
		const firstText = first[0] ? messageText(first[0].payload) : "";
		const lastText = last[0] ? lastParagraph(messageText(last[0].payload)) : null;
		sessions.push({
			sessionId: s.id,
			title: s.title,
			ownerId: s.owner_user_id,
			firstMessage: firstText ? snippet(firstText) : null,
			lastAssistantParagraph: lastText ? snippet(lastText) : null,
			toolCalls: Number(tools[0]?.n ?? 0),
		});
	}

	const inRange = (value: Date | string | null): boolean => {
		const iso = toIso(value);
		return iso !== null && iso >= range[0]! && iso < range[1]!;
	};
	const mrs = await q.query<{ id: string; title: string; author_id: string; status: string; created_at: Date | string; decided_at: Date | string | null; updated_at: Date | string }>(
		`SELECT id, title, author_id, status, created_at, decided_at, updated_at FROM merge_requests
		 WHERE workspace_id = $1 AND (created_at >= $2::timestamptz AND created_at < $3::timestamptz
		   OR decided_at >= $2::timestamptz AND decided_at < $3::timestamptz
		   OR (status = 'conflict' AND updated_at >= $2::timestamptz AND updated_at < $3::timestamptz))
		 ORDER BY created_at, id`,
		[workspaceId, ...range],
	);
	const mergeRequests: MergeRequestMaterial[] = mrs.map((m) => {
		const happened: MergeRequestMaterial["happened"] = [];
		if (inRange(m.created_at)) happened.push("created");
		if (m.status === "merged" && inRange(m.decided_at)) happened.push("merged");
		if (m.status === "rejected" && inRange(m.decided_at)) happened.push("rejected");
		if (m.status === "conflict") happened.push("conflict");
		return { id: m.id, title: m.title, authorId: m.author_id, status: m.status, happened };
	});

	const ids = [...new Set([...sessions.map((s) => s.ownerId), ...mergeRequests.map((m) => m.authorId)])];
	const users = ids.length > 0 ? await q.query<{ id: string; display_name: string }>("SELECT id, display_name FROM users WHERE id = ANY($1::text[])", [ids]) : [];
	return { date, sessions, mergeRequests, names: Object.fromEntries(users.map((u) => [u.id, u.display_name])) };
}

/** The rule-based summary used when no model gateway is configured or the model path fails. */
export function buildDigest(material: ReportMaterial): ReportContent {
	const { sessions, mergeRequests, names } = material;
	const nameOf = (id: string): string => names[id] ?? id;
	const members = new Map<string, string[]>();
	const items = (id: string): string[] => {
		const list = members.get(id) ?? [];
		members.set(id, list);
		return list;
	};

	for (const s of sessions) {
		const parts = [`会话「${s.title || "未命名"}」`];
		if (s.firstMessage) parts.push(`起始请求: ${s.firstMessage}`);
		if (s.lastAssistantParagraph) parts.push(`最近进展: ${s.lastAssistantParagraph}`);
		parts.push(`工具调用 ${s.toolCalls} 次`);
		items(s.ownerId).push(parts.join("；"));
	}
	const label: Record<string, string> = { created: "新建", merged: "已合并", rejected: "被拒绝", conflict: "存在冲突" };
	for (const m of mergeRequests) items(m.authorId).push(`合并请求「${m.title}」: ${m.happened.map((h) => label[h]).join("、") || m.status}`);

	const count = (h: MergeRequestMaterial["happened"][number]): number => mergeRequests.filter((m) => m.happened.includes(h)).length;
	const overall: string[] = [];
	if (sessions.length === 0 && mergeRequests.length === 0) {
		overall.push("当天没有会话活动或合并请求");
	} else {
		const owners = new Set(sessions.map((s) => s.ownerId));
		overall.push(`${owners.size} 位成员有会话活动，共 ${sessions.length} 个会话，${sessions.reduce((n, s) => n + s.toolCalls, 0)} 次工具调用`);
		if (mergeRequests.length > 0) overall.push(`合并请求: 新建 ${count("created")} 个，合并 ${count("merged")} 个，拒绝 ${count("rejected")} 个`);
	}

	const risks: string[] = [];
	for (const m of mergeRequests) {
		if (m.happened.includes("conflict")) risks.push(`合并请求「${m.title}」(${nameOf(m.authorId)}) 存在冲突，需要处理`);
		if (m.happened.includes("rejected")) risks.push(`合并请求「${m.title}」(${nameOf(m.authorId)}) 被拒绝`);
	}

	return { date: material.date, overall, risks, members: [...members].map(([userId, list]) => ({ userId, name: nameOf(userId), items: list })) };
}
