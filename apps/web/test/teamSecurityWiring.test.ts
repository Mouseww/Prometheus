import { describe, expect, it } from "vitest";
import { createApiMethods, type Requester, TeamApiError } from "../src/team/api.ts";
import { dropHand, type HandItem, isDuplicateCallId } from "../src/team/logic/exec.ts";
import { canAddDirectly, isIneligibleMember } from "../src/team/logic/members.ts";
import { isHeadChanged } from "../src/team/logic/mergeRequest.ts";
import { registerOutcome } from "../src/team/logic/publicMode.ts";
import { workbenchTarget } from "../src/team/logic/runtime.ts";
import type { MetaInfo, PublicUser, RegisterResult } from "../src/team/types.ts";

describe("merge request approve", () => {
	it("sends the head commit the reviewer saw", async () => {
		const seen: { method: string; path: string; body?: unknown }[] = [];
		const requester: Requester = {
			async request<T>(method: string, path: string, body?: unknown): Promise<T> {
				seen.push({ method, path, body });
				return undefined as T;
			},
		};
		await createApiMethods(requester).approveMergeRequest("m 1", "abc123");
		expect(seen).toEqual([{ method: "POST", path: "/api/merge-requests/m%201/approve", body: { expectedHeadCommit: "abc123" } }]);
	});

	it("recognises the headChanged conflict only", () => {
		expect(isHeadChanged(new TeamApiError(409, "headChanged", "x"))).toBe(true);
		expect(isHeadChanged(new TeamApiError(409, "mergeConflict", "x"))).toBe(false);
		expect(isHeadChanged(new Error("headChanged"))).toBe(false);
	});
});

describe("hand answer errors", () => {
	it("detects duplicateCallId from a code or a message", () => {
		expect(isDuplicateCallId(new TeamApiError(400, "duplicateCallId", "dup"))).toBe(true);
		expect(isDuplicateCallId({ code: "duplicateCallId" })).toBe(true);
		expect(isDuplicateCallId(new Error("rpc failed: duplicateCallId"))).toBe(true);
		expect(isDuplicateCallId(new Error("offline"))).toBe(false);
		expect(isDuplicateCallId(undefined)).toBe(false);
	});

	it("drops a stale request by call id", () => {
		const item = (callId: string): HandItem => ({ callId, tool: "bash", input: {}, session: "h", insideProject: true, allowSession: false });
		expect(dropHand([item("a"), item("b")], "a").map((h) => h.callId)).toEqual(["b"]);
	});
});

describe("workbenchTarget", () => {
	const fallback = "https://app.example/plugins/team/rt/";
	it("uses an absolute runtime origin from the Hub", () => {
		expect(workbenchTarget("https://rt.example/rt/", fallback, "https://app.example", "t k")).toBe("https://rt.example/rt/?token=t%20k");
	});
	it("resolves a host-relative address against the page origin", () => {
		expect(workbenchTarget("/base/rt/", fallback, "https://app.example", "tok")).toBe("https://app.example/base/rt/?token=tok");
	});
	it("falls back when absent or unsafe", () => {
		expect(workbenchTarget(undefined, fallback, "https://app.example", "tok")).toBe(`${fallback}?token=tok`);
		expect(workbenchTarget("//evil.example/rt/", fallback, "https://app.example", "tok")).toBe(`${fallback}?token=tok`);
		expect(workbenchTarget("javascript:alert(1)", fallback, "https://app.example", "tok")).toBe(`${fallback}?token=tok`);
	});
	it("appends to an existing query string", () => {
		expect(workbenchTarget("https://rt.example/rt/?a=1", fallback, "https://app.example", "tok")).toBe("https://rt.example/rt/?a=1&token=tok");
	});
});

describe("registerOutcome", () => {
	const user = (emailVerifiedAt: string | null): PublicUser => ({ id: "u", email: "a@b.c", displayName: "A", status: "pending", platformRole: null, emailVerifiedAt, createdAt: "2026-01-01T00:00:00Z" });
	const res = (status: RegisterResult["status"], emailVerifiedAt: string | null, bootstrap = false): RegisterResult => ({ user: user(emailVerifiedAt), status, bootstrap });
	const meta = (mode: MetaInfo["mode"]): MetaInfo => ({ version: "1", publicKey: "k", needsSetup: false, registration: { open: true, domains: [], approval: false, invite: true }, mode });

	it("public mode: an unverified account, invitee included, must verify its email", () => {
		expect(registerOutcome(res("pending", null), meta("public"))).toBe("verify");
		expect(registerOutcome(res("active", null), meta("public"))).toBe("verify");
	});
	it("private mode: an active invitee signs in, a pending account waits for approval", () => {
		expect(registerOutcome(res("active", null), meta("private"))).toBe("signIn");
		expect(registerOutcome(res("pending", null), meta("private"))).toBe("approval");
	});
	it("the bootstrap account signs in", () => {
		expect(registerOutcome(res("active", null, true), meta("public"))).toBe("signIn");
	});
});

describe("adding team members", () => {
	it("personal teams are invitation only", () => {
		expect(canAddDirectly({ orgId: null })).toBe(false);
		expect(canAddDirectly({ orgId: "o1" })).toBe(true);
	});
	it("treats a 404 as not eligible and nothing else", () => {
		expect(isIneligibleMember(new TeamApiError(404, "notFound", "x"))).toBe(true);
		expect(isIneligibleMember(new TeamApiError(403, "forbidden", "x"))).toBe(false);
		expect(isIneligibleMember(new Error("404"))).toBe(false);
	});
});
