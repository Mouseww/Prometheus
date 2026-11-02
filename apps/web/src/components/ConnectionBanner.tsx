import { LoaderCircle, WifiOff } from "lucide-react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: {
		lost: "与服务端的连接已断开，正在自动重连。在恢复之前，发送消息、选择工作区等操作无法执行。",
		connecting: "正在连接服务端…",
		restarting: "本地后端已停止响应，正在重新启动…",
		failed: "本地后端重新启动失败：{e}",
		retry: "立即重试",
	},
	en: {
		lost: "The connection to the server was lost; reconnecting automatically. Sending messages, choosing a workspace and similar actions are unavailable until it is back.",
		connecting: "Connecting to the server…",
		restarting: "The local backend stopped responding; restarting it…",
		failed: "Restarting the local backend failed: {e}",
		retry: "Retry now",
	},
});

/** What the app is doing about a dead local backend: nothing, restarting it, or having failed to. */
export type Recovery = { state: "idle" | "restarting" } | { state: "failed"; error: string };

/** Always-visible notice while the socket is down, so a click that cannot work is never met with silence. */
export function ConnectionBanner({ recovery }: { recovery: Recovery }) {
	const t = useT(M);
	const conn = useStore((s) => s.conn);
	const client = useStore((s) => s.client);
	if (conn === "open" || conn === "idle" || conn === "unauthorized") return null;
	const failed = recovery.state === "failed";
	const text = failed ? t("failed", { e: recovery.error }) : recovery.state === "restarting" ? t("restarting") : conn === "connecting" ? t("connecting") : t("lost");
	return (
		<div role="alert" className="flex items-center justify-center gap-2 border-b border-rose-400/30 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200">
			{failed ? <WifiOff className="size-3.5 shrink-0" /> : <LoaderCircle className="size-3.5 shrink-0 animate-spin" />}
			<span className="min-w-0 break-words">{text}</span>
			<button type="button" onClick={() => client?.retryNow()} className="shrink-0 rounded-md border border-rose-300/40 px-2 py-0.5 hover:bg-rose-400/20">
				{t("retry")}
			</button>
		</div>
	);
}
