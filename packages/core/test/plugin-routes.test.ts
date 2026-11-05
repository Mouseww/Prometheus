import { describe, expect, it } from "vitest";
import { matchPluginRoute } from "../src/plugin-routes.ts";

const r = (path: string, method = "GET") => ({ method, path });

describe("matchPluginRoute", () => {
	it("prefers an exact route over a prefix route", () => {
		const routes = [r("/plugins/t/api/*"), r("/plugins/t/api/health")];
		expect(matchPluginRoute(routes, "GET", "/plugins/t/api/health")?.path).toBe("/plugins/t/api/health");
		expect(matchPluginRoute(routes, "GET", "/plugins/t/api/other")?.path).toBe("/plugins/t/api/*");
	});

	it("the longest prefix wins", () => {
		const routes = [r("/plugins/t/*"), r("/plugins/t/api/*"), r("/plugins/t/api/v1/*")];
		expect(matchPluginRoute(routes, "GET", "/plugins/t/api/v1/x/y")?.path).toBe("/plugins/t/api/v1/*");
		expect(matchPluginRoute(routes, "GET", "/plugins/t/api/z")?.path).toBe("/plugins/t/api/*");
		expect(matchPluginRoute(routes, "GET", "/plugins/t/git/x")?.path).toBe("/plugins/t/*");
	});

	it("a prefix does not match a sibling that merely shares the letters, and respects the method", () => {
		const routes = [r("/plugins/t/api/*", "POST")];
		expect(matchPluginRoute(routes, "POST", "/plugins/t/apix")).toBeUndefined();
		expect(matchPluginRoute(routes, "GET", "/plugins/t/api/a")).toBeUndefined();
		expect(matchPluginRoute(routes, "POST", "/plugins/t/api")?.path).toBe("/plugins/t/api/*");
	});

	it("method-less routes (WebSocket) match on path only", () => {
		const routes = [{ path: "/plugins/t/ws" }, { path: "/plugins/t/ws/*" }];
		expect(matchPluginRoute(routes, undefined, "/plugins/t/ws")?.path).toBe("/plugins/t/ws");
		expect(matchPluginRoute(routes, undefined, "/plugins/t/ws/room/1")?.path).toBe("/plugins/t/ws/*");
	});
});
