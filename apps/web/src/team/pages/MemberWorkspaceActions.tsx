// Member mode only: checkout of a team workspace and starting a new team session through the local team plugin.
// Hidden in Hub mode, where there is no local machine to act on.
import { FolderDown, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Dialog, Field, Input } from "../../components/ui.tsx";
import { defineMessages, useT } from "../../lib/i18n.ts";
import { useTeam } from "../context.tsx";
import { useCommonT } from "../i18n.ts";
import { Notice, useAction } from "../kit.tsx";
import { localSessionIdOf } from "../logic/pluginResult.ts";

const M = defineMessages({
	zh: {
		checkout: "检出",
		checkoutDone: "已检出到本机",
		newSession: "新建团队会话",
		titleLabel: "会话标题（可选）",
		start: "开始",
		started: "已创建，正在打开",
		startedNoOpen: "已创建，请在你的 Prometheus 会话列表中打开",
	},
	en: {
		checkout: "Check out",
		checkoutDone: "Checked out to this machine",
		newSession: "New team session",
		titleLabel: "Session title (optional)",
		start: "Start",
		started: "Created, opening it",
		startedNoOpen: "Created. Open it from your Prometheus session list.",
	},
});

export function MemberWorkspaceActions({ workspaceId }: { workspaceId: string }) {
	const { mode, plugin } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const checkout = useAction();
	const start = useAction();
	const [done, setDone] = useState<string | undefined>(undefined);
	const [dialog, setDialog] = useState(false);
	const [title, setTitle] = useState("");
	if (mode !== "member" || !plugin) return null;

	const doCheckout = async () => {
		setDone(undefined);
		const r = await checkout.run(() => plugin.call("workspace.checkout", { workspaceId }));
		if (r !== undefined) setDone(t("checkoutDone"));
	};

	const doStart = async (e: FormEvent) => {
		e.preventDefault();
		setDone(undefined);
		const params: Record<string, unknown> = { workspaceId };
		if (title.trim()) params.title = title.trim();
		const r = await start.run(() => plugin.call("session.start", params));
		if (r === undefined) return;
		setDialog(false);
		setTitle("");
		const id = localSessionIdOf(r);
		if (id) {
			setDone(t("started"));
			plugin.openLocalSession(id);
		} else setDone(t("startedNoOpen"));
	};

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button variant="outline" disabled={checkout.busy} onClick={() => void doCheckout()}>
				<FolderDown className="size-4" aria-hidden /> {t("checkout")}
			</Button>
			<Button variant="primary" onClick={() => setDialog(true)}>
				<Plus className="size-4" aria-hidden /> {t("newSession")}
			</Button>
			{done && <Notice kind="ok">{done}</Notice>}
			{checkout.error && <Notice kind="error">{checkout.error}</Notice>}
			{dialog && (
				<Dialog title={t("newSession")} onClose={() => setDialog(false)}>
					<form onSubmit={(e) => void doStart(e)} className="space-y-3">
						<Field label={t("titleLabel")}>
							<Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoFocus />
						</Field>
						{start.error && <Notice kind="error">{start.error}</Notice>}
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setDialog(false)}>
								{c("cancel")}
							</Button>
							<Button type="submit" variant="primary" disabled={start.busy}>
								{t("start")}
							</Button>
						</div>
					</form>
				</Dialog>
			)}
		</div>
	);
}
