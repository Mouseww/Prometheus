import { describe, expect, it, vi } from "vitest";
import { TeamApiError } from "../src/team/api.ts";
import { createMemberApi } from "../src/team/memberApi.ts";

describe("createMemberApi", () => {
	it("relays every request through team / hub.request with Hub-relative paths", async () => {
		const call = vi.fn(async () => ({ ok: true, data: [{ id: "t1" }] }));
		const api = createMemberApi(call);
		await expect(api.listTeams()).resolves.toEqual([{ id: "t1" }]);
		await api.createTeam({ name: "Core", orgId: "o1" });
		await api.listMergeRequests("w1", { status: "conflict" });
		await api.addTeamMember("t1", { email: "a@b.co", role: "member" });
		await api.removeTeamMember("t1", "u1");
		expect(call.mock.calls).toEqual([
			["team", "hub.request", { method: "GET", path: "/api/teams" }],
			["team", "hub.request", { method: "POST", path: "/api/teams", body: { name: "Core", orgId: "o1" } }],
			["team", "hub.request", { method: "GET", path: "/api/workspaces/w1/merge-requests?status=conflict" }],
			["team", "hub.request", { method: "POST", path: "/api/teams/t1/members", body: { email: "a@b.co", role: "member" } }],
			["team", "hub.request", { method: "DELETE", path: "/api/teams/t1/members/u1" }],
		]);
	});

	it("accepts plain data as well as an envelope", async () => {
		const api = createMemberApi(async () => ({ allowPersonalTeams: true }));
		await expect(api.getSettings()).resolves.toEqual({ allowPersonalTeams: true });
	});

	it("throws TeamApiError for an error envelope", async () => {
		const api = createMemberApi(async () => ({ ok: false, error: { code: "mergeConflict", message: "conflict" } }));
		await expect(api.approveMergeRequest("m1", "h1")).rejects.toMatchObject({ code: "mergeConflict", message: "conflict" });
	});

	it("wraps a rejected plugin call and an empty reply", async () => {
		const failing = createMemberApi(async () => {
			throw new Error("Hub offline");
		});
		await expect(failing.me()).rejects.toMatchObject({ name: "TeamApiError", code: "plugin", message: "Hub offline" });
		const silent = createMemberApi(async () => undefined);
		await expect(silent.me()).rejects.toBeInstanceOf(TeamApiError);
	});

	it("subscribes through the plugin watch on hub:<topic>", () => {
		const off = vi.fn();
		const watch = vi.fn(() => off);
		const api = createMemberApi(async () => ({}), watch);
		const cb = vi.fn();
		const stop = api.subscribe("workspace:w1", cb);
		expect(watch).toHaveBeenCalledWith("team", "hub:workspace:w1", cb);
		stop();
		expect(off).toHaveBeenCalled();
	});

	it("subscribe is a harmless no-op without a watch transport", () => {
		const api = createMemberApi(async () => ({}));
		expect(() => api.subscribe("user", () => undefined)()).not.toThrow();
	});
});
