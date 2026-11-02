/**
 * Error log: records everything the server and its plugins print through console.error / console.warn
 * (which includes uncaught exceptions and unhandled rejections, see apps/server/src/main.ts) and shows it in
 * Settings → Error log. The view is native (`apps/web/src/components/LogsView.tsx`), so there is no HTTP surface.
 */
import { join } from "node:path";
import { definePlugin } from "@prometheus/plugin-sdk";
import { captureConsole, LogStore, type LogLevel } from "./log-store.ts";

export default definePlugin({
	name: "logs",
	version: "0.1.0",
	optional: true,
	setup(ctx) {
		const store = new LogStore(join(ctx.dataDir, "errors.jsonl"));
		const restore = captureConsole(store);
		ctx.onDispose(restore);

		const level = (v: unknown): LogLevel | undefined => (v === "error" || v === "warn" ? v : undefined);

		ctx.rpc("list", (params) => {
			const limit = typeof params?.limit === "number" ? Math.min(Math.max(1, params.limit), 500) : 200;
			return { entries: store.list(level(params?.level), limit), counts: store.counts() };
		});
		ctx.rpc("clear", () => {
			store.clear();
			return { entries: [], counts: store.counts() };
		});
	},
});
