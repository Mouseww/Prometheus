// Shared bits of the runtime pages: state badge and driver label.
import { Badge } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { statusTone } from "../../logic/runtime.ts";
import type { RuntimeKind, RuntimeStatus } from "../../types.ts";

export const R = defineMessages({
	zh: {
		stopped: "已停止",
		starting: "启动中",
		running: "运行中",
		stopping: "停止中",
		failed: "失败",
		docker: "Docker 容器",
		sandbox: "沙箱账号",
		restricted: "受限进程",
		noDriver: "未分配",
	},
	en: {
		stopped: "Stopped",
		starting: "Starting",
		running: "Running",
		stopping: "Stopping",
		failed: "Failed",
		docker: "Docker container",
		sandbox: "Sandbox account",
		restricted: "Restricted process",
		noDriver: "Unassigned",
	},
});

export function RuntimeStatusBadge({ status }: { status: RuntimeStatus }) {
	const t = useT(R);
	return <Badge tone={statusTone(status)}>{t(status)}</Badge>;
}

export function useDriverLabel(): (driver: RuntimeKind | null) => string {
	const t = useT(R);
	return (driver) => (driver ? t(driver) : t("noDriver"));
}
