import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, localDate, parseClock, reportDue, zonedDayRange, zonedParts } from "../src/scheduler.ts";
import { buildDigest, messageText } from "../src/services/reports-material.ts";
import { parseModelReport } from "../src/services/reports.ts";
import { ulid } from "../src/ids.ts";
import type { ReportScheduler } from "../src/scheduler.ts";
import { connectWs, type Collab, startCollab, startUpstream, type Upstream } from "./s-helpers.ts";

let c: Collab;
beforeAll(async () => {
	c = await startCollab();
});
afterAll(async () => {
	await c.stop();
});

/** Shanghai is the default workspace zone; "today" there is what events written now fall into. */
const today = (): string => localDate(Date.now() + c.clock.offset, "Asia/Shanghai");
const ev = (seq: number, kind: string, payload: unknown = {}) => ({ seq, kind, payload });

async function seedActivity(): Promise<{ alice: any; bob: any }> {
	const a = await c.registerSession(c.alice, { title: "Fix login bug" });
	const b = await c.registerSession(c.bob, { title: "Write docs" });
	await c.t.api("POST", `/api/sessions/${a.id}/events`, {
		token: c.alice.token,
		body: {
			events: [
				ev(0, "agent_start"),
				ev(1, "message_end", { message: { role: "user", content: [{ type: "text", text: "Fix the login bug in auth.ts" }] } }),
				ev(2, "tool_execution_start", { toolName: "read" }),
				ev(3, "tool_execution_start", { toolName: "edit" }),
				ev(4, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "Looking at it.\n\nFixed the null check in auth.ts" }] } }),
				ev(5, "agent_end"),
			],
		},
	});
	await c.t.api("POST", `/api/sessions/${b.id}/events`, { token: c.bob.token, body: { events: [ev(0, "message_end", { message: { role: "user", content: "Document the API" } })] } });
	return { alice: a, bob: b };
}

async function clearReports(): Promise<void> {
	await c.t.hub.db.tx({ system: true }, (q) => q.query("DELETE FROM daily_reports WHERE workspace_id = $1", [c.workspaceId]));
}

describe("time zone helpers", () => {
	it("computes wall-clock parts and local dates", () => {
		const instant = Date.UTC(2026, 10, 5, 17, 30); // 2026-11-05 17:30 UTC
		expect(zonedParts(instant, "Asia/Shanghai")).toEqual({ year: 2026, month: 11, day: 6, hour: 1, minute: 30 });
		expect(zonedParts(instant, "America/Los_Angeles")).toEqual({ year: 2026, month: 11, day: 5, hour: 9, minute: 30 });
		expect(localDate(instant, "Asia/Shanghai")).toBe("2026-11-06");
		expect(localDate(instant, "UTC")).toBe("2026-11-05");
	});

	it("finds local day boundaries including DST days", () => {
		const sh = zonedDayRange("2026-11-05", "Asia/Shanghai");
		expect(sh.start.toISOString()).toBe("2026-11-04T16:00:00.000Z");
		expect(sh.end.toISOString()).toBe("2026-11-05T16:00:00.000Z");
		// US spring forward 2026-03-08: a 23 hour day.
		const la = zonedDayRange("2026-03-08", "America/Los_Angeles");
		expect(la.start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
		expect((la.end.getTime() - la.start.getTime()) / 3_600_000).toBe(23);
		// Fall back 2026-11-01: 25 hours.
		const fall = zonedDayRange("2026-11-01", "America/Los_Angeles");
		expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
	});

	it("does calendar arithmetic and parses clock times", () => {
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(parseClock("09:00")).toBe(540);
		expect(parseClock("9:05")).toBe(545);
		expect(parseClock("24:00")).toBeUndefined();
		expect(parseClock("nine")).toBeUndefined();
	});
});

describe("scheduler due-time logic", () => {
	it("is due once the local clock reaches the configured time, for the previous local day", () => {
		// 2026-11-05 00:59 UTC = 08:59 in Shanghai.
		const before = Date.UTC(2026, 10, 5, 0, 59);
		expect(reportDue(before, "Asia/Shanghai", "09:00")).toEqual({ due: false, date: "2026-11-04" });
		const at = Date.UTC(2026, 10, 5, 1, 0);
		expect(reportDue(at, "Asia/Shanghai", "09:00")).toEqual({ due: true, date: "2026-11-04" });
		// Still due later in the day (catch-up after downtime).
		expect(reportDue(Date.UTC(2026, 10, 5, 13, 0), "Asia/Shanghai", "09:00")).toEqual({ due: true, date: "2026-11-04" });
	});

	it("uses the workspace zone, not the server's", () => {
		const instant = Date.UTC(2026, 10, 5, 2, 0); // 02:00 UTC
		expect(reportDue(instant, "Asia/Shanghai", "09:00")).toMatchObject({ due: true, date: "2026-11-04" });
		// Los Angeles is still on Nov 4 at 18:00.
		expect(reportDue(instant, "America/Los_Angeles", "09:00")).toEqual({ due: true, date: "2026-11-03" });
		expect(reportDue(instant, "America/Los_Angeles", "19:00")).toEqual({ due: false, date: "2026-11-03" });
	});

	it("falls back to UTC for unknown zones and never fires for malformed times", () => {
		const instant = Date.UTC(2026, 10, 5, 10, 0);
		expect(reportDue(instant, "Mars/Olympus", "09:00")).toEqual({ due: true, date: "2026-11-04" });
		expect(reportDue(instant, "UTC", "soon").due).toBe(false);
	});

	describe("tick", () => {
		let scheduler: ReportScheduler;
		beforeAll(() => {
			scheduler = c.t.hub.registry.require<ReportScheduler>("reportScheduler");
		});

		it("generates yesterday's report once for due workspaces and skips disabled, not-yet-due and brand-new ones", async () => {
			const old = "3 days";
			const mk = async (name: string, time: string, enabled: boolean, age = old): Promise<string> => {
				const id = ulid();
				await c.t.hub.db.tx({ system: true }, (q) =>
					q.query(
						`INSERT INTO workspaces (id, team_id, org_id, name, repo_dir, daily_report_time, daily_report_tz, daily_report_enabled, created_at)
						 VALUES ($1,$2,$3,$4,'r',$5,'UTC',$6, now() - $7::interval)`,
						[id, c.teamId, c.root.orgId, name, time, enabled, age],
					),
				);
				return id;
			};
			const due = await mk("due", "00:00", true);
			const disabled = await mk("disabled", "00:00", false);
			const never = await mk("never", "24:00", true);
			const fresh = await mk("fresh", "00:00", true, "0 seconds");
			// Make sure only these four are considered: every other workspace is disabled for this test.
			await c.t.hub.db.tx({ system: true }, (q) => q.query("UPDATE workspaces SET daily_report_enabled = false WHERE id NOT IN ($1,$2,$3,$4) OR id = $2", [due, disabled, never, fresh]));
			await c.t.hub.db.tx({ system: true }, (q) => q.query("UPDATE workspaces SET daily_report_enabled = true WHERE id IN ($1,$2,$3)", [due, never, fresh]));

			const yesterday = addDays(localDate(Date.now() + c.clock.offset, "UTC"), -1);
			const first = await scheduler.tick();
			expect(first).toEqual([`${due}:${yesterday}`]);
			expect(await scheduler.tick()).toEqual([]);

			const rows = await c.t.hub.db.query<{ workspace_id: string; d: string; generated_by: string }>("SELECT workspace_id, report_date::text AS d, generated_by FROM daily_reports WHERE workspace_id = ANY($1::text[])", [[due, disabled, never, fresh]]);
			expect(rows).toEqual([{ workspace_id: due, d: yesterday, generated_by: "digest" }]);
		});
	});
});

describe("digest", () => {
	it("extracts text from message payloads", () => {
		expect(messageText({ message: { content: "plain" } })).toBe("plain");
		expect(messageText({ message: { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] } })).toBe("a\nb");
		expect(messageText(null)).toBe("");
		expect(messageText({ message: 3 })).toBe("");
	});

	it("builds an empty-day digest", () => {
		const d = buildDigest({ date: "2026-11-04", sessions: [], mergeRequests: [], names: {} });
		expect(d.overall).toEqual(["当天没有会话活动或合并请求"]);
		expect(d.members).toEqual([]);
	});

	it("generates a rule-based report through the API when no gateway exists", async () => {
		await clearReports();
		const { alice } = await seedActivity();
		await c.t.hub.db.tx({ system: true }, (q) =>
			q.query(
				`INSERT INTO merge_requests (id, workspace_id, org_id, author_id, title, branch, base_commit, head_commit, status) VALUES ($1,$2,$3,$4,'Fix login','b','a','b','conflict')`,
				[ulid(), c.workspaceId, c.root.orgId, c.alice.userId],
			),
		);
		const r = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: today() } });
		expect(r.status).toBe(201);
		expect(r.data).toMatchObject({ date: today(), generatedBy: "digest", workspaceId: c.workspaceId });
		const content = r.data.content;
		expect(content.date).toBe(today());
		expect(content.overall[0]).toMatch(/2 位成员有会话活动，共 \d+ 个会话，2 次工具调用/);
		expect(content.risks.join("\n")).toContain("Fix login");
		const aliceBlock = content.members.find((m: any) => m.userId === c.alice.userId);
		expect(aliceBlock.name).toBe("Alice");
		const line = aliceBlock.items.find((i: string) => i.includes("Fix login bug"));
		expect(line).toContain("起始请求: Fix the login bug in auth.ts");
		expect(line).toContain("最近进展: Fixed the null check in auth.ts");
		expect(line).toContain("工具调用 2 次");
		expect(content.members.find((m: any) => m.userId === c.bob.userId).items.some((i: string) => i.includes("起始请求: Document the API"))).toBe(true);
		expect(alice.id).toBeTruthy();

		const got = await c.t.api("GET", `/api/workspaces/${c.workspaceId}/reports?date=${today()}`, { token: c.bob.token });
		expect(got.data.content).toEqual(content);
	});

	it("does not call a model and records no usage in digest mode", async () => {
		const usage = await c.t.api("GET", "/api/admin/usage?groupBy=user", { token: c.root.token });
		expect(usage.data).toEqual([]);
	});
});

describe("GET and POST reports permissions", () => {
	it("returns the latest report without a date and null when none exists", async () => {
		await clearReports();
		const empty = await c.t.api("GET", `/api/workspaces/${c.workspaceId}/reports`, { token: c.bob.token });
		expect(empty.status).toBe(200);
		expect(empty.data).toBeNull();
		await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: "2026-01-02" } });
		await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: "2026-01-03" } });
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/reports`, { token: c.bob.token })).data.date).toBe("2026-01-03");
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/reports?date=2026-01-02`, { token: c.bob.token })).data.date).toBe("2026-01-02");
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/reports?date=2026-01-09`, { token: c.bob.token })).data).toBeNull();
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/reports?date=yesterday`, { token: c.bob.token })).status).toBe(400);
		expect((await c.t.api("GET", `/api/workspaces/${c.workspaceId}/reports`, { token: c.carol.token })).status).toBe(404);
	});

	it("only team admins generate, defaulting to yesterday, and regeneration replaces the report", async () => {
		await clearReports();
		expect((await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.bob.token, body: {} })).status).toBe(403);
		expect((await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.carol.token, body: {} })).status).toBe(404);
		expect((await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: "01/02/2026" } })).status).toBe(400);
		const auto = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token });
		expect(auto.data.date).toBe(addDays(today(), -1));
		const again = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: auto.data.date } });
		expect(again.data.id).toBe(auto.data.id);
		const count = await c.t.hub.db.query<{ n: string }>("SELECT count(*) AS n FROM daily_reports WHERE workspace_id = $1", [c.workspaceId]);
		expect(Number(count[0]?.n)).toBe(1);
	});

	it("pushes report.generated to the workspace topic", async () => {
		const ws = await connectWs(c.t.baseUrl, c.bob.token);
		await ws.subscribe(`workspace:${c.workspaceId}`);
		await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: "2026-02-02" } });
		const f = await ws.waitFor((x) => x.data?.kind === "report.generated");
		expect(f.data).toMatchObject({ workspaceId: c.workspaceId, date: "2026-02-02", generatedBy: "digest" });
		await ws.close();
	});
});

describe("model report", () => {
	let upstream: Upstream;
	let respond: (res: import("node:http").ServerResponse, body: string) => void;
	let reply: () => { status: number; body: unknown };
	let gatewayId: string;

	beforeAll(async () => {
		respond = (res, body) => {
			res.setHeader("content-type", "application/json");
			res.end(body);
		};
		reply = () => ({ status: 200, body: {} });
		upstream = await startUpstream((_req, res) => {
			const r = reply();
			res.statusCode = r.status;
			respond(res, typeof r.body === "string" ? r.body : JSON.stringify(r.body));
		});
		const g = await c.t.api("POST", "/api/admin/gateways", {
			token: c.root.token,
			body: { scope: "platform", name: "report-gw", format: "openai", baseUrl: `${upstream.url}/v1`, apiKey: "sk-report-secret-1234", models: [{ id: "gpt-report" }] },
		});
		gatewayId = g.data.id;
		await clearReports();
		await seedActivity();
	});
	afterAll(async () => {
		await upstream.stop();
	});

	const chatReply = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } } });
	const generate = () => c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: today() } });

	it("uses the gateway with a strict JSON schema and books usage to 'system'", async () => {
		reply = () =>
			chatReply(
				JSON.stringify({
					overall: ["Login bug fixed", "Docs started"],
					risks: ["One merge request conflicts"],
					members: [
						{ userId: c.alice.userId, items: ["Fixed null check in auth.ts"] },
						{ userId: "unknown-user", items: ["ignored"] },
					],
				}),
			);
		const before = upstream.requests.length;
		const r = await generate();
		expect(r.data.generatedBy).toBe("model");
		expect(r.data.content).toEqual({
			date: today(),
			overall: ["Login bug fixed", "Docs started"],
			risks: ["One merge request conflicts"],
			members: [{ userId: c.alice.userId, name: "Alice", items: ["Fixed null check in auth.ts"] }],
		});

		const req = upstream.requests[before]!;
		expect(req.url).toBe("/v1/chat/completions");
		expect(req.headers.authorization).toBe("Bearer sk-report-secret-1234");
		const body = JSON.parse(req.body);
		expect(body.model).toBe("gpt-report");
		expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "daily_report", strict: true } });
		expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
		expect(body.messages[1].content).toContain("Fix the login bug in auth.ts");

		const usage = await c.t.api("GET", "/api/admin/usage?groupBy=user", { token: c.root.token });
		expect(usage.data).toEqual([expect.objectContaining({ key: "system", inputTokens: 120, outputTokens: 30, requests: 1 })]);
		const ledger = await c.t.hub.db.query<{ gateway_id: string; model: string; source: string; org_id: string | null }>("SELECT gateway_id, model, source, org_id FROM usage_ledger WHERE user_id = 'system'");
		expect(ledger).toEqual([{ gateway_id: gatewayId, model: "gpt-report", source: "platform", org_id: c.root.orgId }]);
	});

	it("falls back to the digest on bad JSON, wrong shapes, empty results and upstream errors", async () => {
		for (const r of [
			chatReply("this is not json at all"),
			chatReply(JSON.stringify({ overall: "a string", risks: [], members: [] })),
			chatReply(JSON.stringify({ overall: [], risks: ["x"], members: [{ userId: "stranger", items: ["y"] }] })),
			chatReply("{ broken json"),
			{ status: 500, body: { error: "boom" } },
			{ status: 200, body: "<html>gateway error</html>" },
		]) {
			reply = () => r;
			const out = await generate();
			expect(out.status).toBe(201);
			expect(out.data.generatedBy).toBe("digest");
			expect(out.data.content.members.length).toBeGreaterThan(0);
		}
	});

	it("tolerates JSON wrapped in a code fence", async () => {
		reply = () => chatReply(`Here you go:\n\`\`\`json\n${JSON.stringify({ overall: ["ok"], risks: [], members: [] })}\n\`\`\``);
		const out = await generate();
		expect(out.data.generatedBy).toBe("model");
		expect(out.data.content.overall).toEqual(["ok"]);
	});

	it("falls back when the gateway is disabled or unreachable", async () => {
		await c.t.api("PUT", `/api/admin/gateways/${gatewayId}`, { token: c.root.token, body: { enabled: false } });
		expect((await generate()).data.generatedBy).toBe("digest");
		await c.t.api("PUT", `/api/admin/gateways/${gatewayId}`, { token: c.root.token, body: { enabled: true, baseUrl: "http://127.0.0.1:9" } });
		expect((await generate()).data.generatedBy).toBe("digest");
		await c.t.api("PUT", `/api/admin/gateways/${gatewayId}`, { token: c.root.token, body: { baseUrl: `${upstream.url}/v1` } });
	});

	it("skips the model on an empty day", async () => {
		const before = upstream.requests.length;
		const out = await c.t.api("POST", `/api/workspaces/${c.workspaceId}/reports/generate`, { token: c.root.token, body: { date: "2001-01-01" } });
		expect(out.data.generatedBy).toBe("digest");
		expect(upstream.requests.length).toBe(before);
	});

	it("prefers an organization gateway over the platform one", async () => {
		const orgUp = await startUpstream((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(chatReply(JSON.stringify({ overall: ["from org"], risks: [], members: [] })).body));
		});
		const g = await c.t.api("POST", "/api/admin/gateways", {
			token: c.root.token,
			body: { scope: "org", scopeId: c.root.orgId, name: "org-gw", format: "openai", baseUrl: orgUp.url, apiKey: "sk-org-key-0000", models: ["org-model"] },
		});
		const out = await generate();
		expect(out.data.content.overall).toEqual(["from org"]);
		expect(orgUp.requests[0]?.headers.authorization).toBe("Bearer sk-org-key-0000");
		await c.t.api("DELETE", `/api/admin/gateways/${g.data.id}`, { token: c.root.token });
		await orgUp.stop();
	});
});

describe("parseModelReport", () => {
	const material = { date: "2026-11-04", sessions: [{ sessionId: "s", title: "t", ownerId: "u1", firstMessage: null, lastAssistantParagraph: null, toolCalls: 0 }], mergeRequests: [], names: { u1: "One" } };

	it("accepts well formed output, trims noise and rejects the rest", () => {
		expect(parseModelReport({ overall: ["a", "  "], risks: [], members: [{ userId: "u1", items: ["x", ""] }] }, material)).toEqual({
			date: "2026-11-04",
			overall: ["a"],
			risks: [],
			members: [{ userId: "u1", name: "One", items: ["x"] }],
		});
		expect(parseModelReport({ overall: [], risks: [], members: [] }, material)).toBeUndefined();
		expect(parseModelReport(null, material)).toBeUndefined();
		expect(parseModelReport({ overall: [1], risks: [], members: [] }, material)).toBeUndefined();
	});
});
