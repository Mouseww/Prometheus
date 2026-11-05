// Operator: tenant instances (one Prometheus per member on the team server): who runs where, state, last activity, stop, limits.
import { Boxes, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Badge, Button, Dialog, Empty, Field, Input, PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, ConfirmButton, ErrorBox, Notice, shortDate, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { canStopRuntime, isTransitional, limitsFromForm, sortRuntimes, userLabel } from "../../logic/runtime.ts";
import type { RuntimeView } from "../../types.ts";
import { RuntimeStatusBadge, useDriverLabel } from "../runtime/status.tsx";

const POLL_MS = 3000;

const M = defineMessages({
	zh: {
		title: "租户实例",
		subtitle: "每位成员在团队 server 上的 Prometheus。空闲一段时间后会自动停止。",
		user: "用户",
		driver: "运行方式",
		state: "状态",
		node: "节点",
		lastActive: "最近活动",
		connections: "连接",
		limits: "资源限制",
		none: "还没有租户实例",
		noneHint: "成员第一次打开「我的工作台」或把会话移交到团队 server 时，会自动创建实例。",
		stop: "停止",
		stopNamed: "管理 {name}",
		editLimits: "编辑限制",
		cpuLimit: "CPU 上限（核）",
		memLimit: "内存上限（MB）",
		limitsHint: "留空表示不限制。已在运行的实例在重启后生效。",
		invalidCpu: "CPU 上限必须是 0 到 256 之间的数",
		invalidMem: "内存上限必须是不小于 64 的整数",
		restartRequired: "需重启生效",
		unlimited: "不限",
		localNode: "本机",
		drivers: "运行方式可用性",
		mode: "当前模式：{mode}，选用：{selected}",
		available: "可用",
		unavailable: "不可用",
		count: "共 {n} 个实例",
		operatorOnly: "只有运营者可以管理租户实例。",
		never: "从未",
		save: "保存",
		cancel: "取消",
		none2: "无",
	},
	en: {
		title: "Tenant instances",
		subtitle: "Each member's Prometheus on the team server. Idle instances stop on their own.",
		user: "User",
		driver: "Runs as",
		state: "State",
		node: "Node",
		lastActive: "Last active",
		connections: "Connections",
		limits: "Limits",
		none: "No tenant instances yet",
		noneHint: "An instance is created when a member first opens My workbench or hands a session to the team server.",
		stop: "Stop",
		stopNamed: "Manage {name}",
		editLimits: "Edit limits",
		cpuLimit: "CPU limit (cores)",
		memLimit: "Memory limit (MB)",
		limitsHint: "Leave empty for no limit. A running instance picks them up after a restart.",
		invalidCpu: "CPU limit must be a number between 0 and 256",
		invalidMem: "Memory limit must be a whole number of at least 64",
		restartRequired: "Restart to apply",
		unlimited: "No limit",
		localNode: "This machine",
		drivers: "Driver availability",
		mode: "Mode: {mode}, selected: {selected}",
		available: "Available",
		unavailable: "Unavailable",
		count: "{n} instances",
		operatorOnly: "Only the operator can manage tenant instances.",
		never: "Never",
		save: "Save",
		cancel: "Cancel",
		none2: "None",
	},
});

function LimitsDialog({ rt, name, onClose, onSaved }: { rt: RuntimeView; name: string; onClose: () => void; onSaved: () => void }) {
	const { api } = useTeam();
	const t = useT(M);
	const [cpu, setCpu] = useState(rt.cpuLimit === null ? "" : String(rt.cpuLimit));
	const [mem, setMem] = useState(rt.memLimitMb === null ? "" : String(rt.memLimitMb));
	const [invalid, setInvalid] = useState<string | undefined>(undefined);
	const { busy, error, run } = useAction();

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const parsed = limitsFromForm(cpu, mem);
		if (!parsed.ok) return setInvalid(t(parsed.field === "cpuLimit" ? "invalidCpu" : "invalidMem"));
		if (await run(() => api.setRuntimeLimits(rt.userId, { cpuLimit: parsed.cpuLimit, memLimitMb: parsed.memLimitMb }))) onSaved();
	};

	return (
		<Dialog title={`${t("editLimits")}: ${name}`} onClose={onClose}>
			<form onSubmit={submit} className="space-y-3">
				<Field label={t("cpuLimit")}>
					<Input value={cpu} onChange={(e) => (setInvalid(undefined), setCpu(e.target.value))} inputMode="decimal" autoComplete="off" autoFocus />
				</Field>
				<Field label={t("memLimit")} hint={t("limitsHint")}>
					<Input value={mem} onChange={(e) => (setInvalid(undefined), setMem(e.target.value))} inputMode="numeric" autoComplete="off" />
				</Field>
				{invalid && <Notice kind="error">{invalid}</Notice>}
				{error && <Notice kind="error">{error}</Notice>}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button type="submit" variant="primary" disabled={busy}>
						{t("save")}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

export function RuntimesPage() {
	const { api, me } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const driverLabel = useDriverLabel();
	const operator = isOperator(me);
	const list = useAsync(() => (operator ? api.listRuntimes() : Promise.resolve({ items: [], mode: "auto" as const, selected: null, drivers: [] })), [api, operator]);
	// Names are a nicety: a failed lookup leaves the short id.
	const users = useAsync(() => (operator ? api.listUsers().catch(() => []) : Promise.resolve([])), [api, operator]);
	const [editing, setEditing] = useState<RuntimeView | undefined>(undefined);
	const { busy, error, run } = useAction();

	const busyRows = list.data?.items.some((r) => isTransitional(r.status)) ?? false;
	const reload = list.reload;
	useEffect(() => {
		if (!busyRows) return;
		const id = window.setInterval(reload, POLL_MS);
		return () => window.clearInterval(id);
	}, [busyRows, reload]);

	if (!operator) return <ErrorBox message={t("operatorOnly")} />;

	const names: Record<string, string> = {};
	for (const u of users.data ?? []) names[u.id] = u.displayName || u.email;
	const nodeName = (id: string | null): string => (id === null ? t("localNode") : id.slice(0, 8));

	return (
		<>
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="ghost" onClick={list.reload} disabled={list.loading}>
						{c("refresh")}
					</Button>
				}
			/>
			<Body className="space-y-4">
				{error && <Notice kind="error">{error}</Notice>}
				<AsyncView state={list}>
					{(data) => (
						<>
							<Card title={t("drivers")}>
								<p className="mb-2 text-xs text-ink-500">{t("mode", { mode: data.mode, selected: data.selected ? driverLabel(data.selected) : t("none2") })}</p>
								<ul className="flex flex-wrap gap-2">
									{data.drivers.map((d) => (
										<li key={d.kind} title={d.reason} className="flex items-center gap-1.5 rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300">
											{driverLabel(d.kind)}
											<Badge tone={d.available ? "moss" : "muted"}>{t(d.available ? "available" : "unavailable")}</Badge>
											{!d.available && d.reason && <span className="max-w-64 truncate text-ink-500">{d.reason}</span>}
										</li>
									))}
								</ul>
							</Card>
							{data.items.length === 0 ? (
								<Empty icon={<Boxes className="size-5" />} title={t("none")}>
									{t("noneHint")}
								</Empty>
							) : (
								<div className="space-y-2">
									<p className="text-xs text-ink-500">{t("count", { n: data.items.length })}</p>
									<Table label={t("title")} head={[t("user"), t("driver"), t("state"), t("node"), t("lastActive"), t("connections"), t("limits"), ""]}>
										{sortRuntimes(data.items).map((r) => {
											const name = userLabel(r.userId, names);
											return (
												<tr key={r.userId}>
													<Td className="font-medium text-ink-100">{name}</Td>
													<Td className="text-ink-300">{driverLabel(r.driver)}</Td>
													<Td>
														<RuntimeStatusBadge status={r.status} />
														{r.status === "failed" && r.lastError && <p className="mt-1 max-w-56 text-xs break-words text-rose-400">{r.lastError}</p>}
													</Td>
													<Td className="font-mono text-xs text-ink-400">{nodeName(r.nodeId)}</Td>
													<Td className="text-xs text-ink-400">{r.lastSeenAt ? shortDate(r.lastSeenAt, lang) : t("never")}</Td>
													<Td className="text-ink-300">{r.activeConnections}</Td>
													<Td className="text-xs text-ink-300">
														<p>
															{r.cpuLimit ?? t("unlimited")} / {r.memLimitMb === null ? t("unlimited") : `${r.memLimitMb} MB`}
														</p>
														{r.restartRequired && <Badge tone="ember">{t("restartRequired")}</Badge>}
													</Td>
													<Td className="text-right">
														<span role="group" aria-label={t("stopNamed", { name })} className="inline-flex flex-wrap justify-end gap-1.5">
															<Button variant="ghost" onClick={() => setEditing(r)} title={t("editLimits")} aria-label={`${t("editLimits")}: ${name}`}>
																<SlidersHorizontal className="size-4" aria-hidden />
															</Button>
															{canStopRuntime(r.status) && <ConfirmButton label={t("stop")} disabled={busy} onConfirm={() => void run(() => api.stopRuntime(r.userId)).then((v) => v && list.reload())} />}
														</span>
													</Td>
												</tr>
											);
										})}
									</Table>
								</div>
							)}
						</>
					)}
				</AsyncView>
			</Body>
			{editing && (
				<LimitsDialog
					rt={editing}
					name={userLabel(editing.userId, names)}
					onClose={() => setEditing(undefined)}
					onSaved={() => {
						setEditing(undefined);
						list.reload();
					}}
				/>
			)}
		</>
	);
}
