// Operator: executor nodes (Docker Engines the Hub places tenant containers on): register, check, drain, remove, capacity.
import { Plus, Server } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Empty, Field, Input, PageHeader } from "../../../components/ui.tsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import { usePrefs } from "../../../lib/prefs.ts";
import { isOperator, useTeam } from "../../context.tsx";
import { useCommonT } from "../../i18n.ts";
import { AsyncView, Body, Card, ConfirmButton, ErrorBox, Notice, shortDate, Table, Td, useAction, useAsync } from "../../kit.tsx";
import { EMPTY_NODE_FORM, formatMem, loadTone, type NodeForm, nodeInputFromForm, nodeLoad } from "../../logic/runtime.ts";
import type { NodeStatus, NodeView } from "../../types.ts";

const M = defineMessages({
	zh: {
		title: "执行节点",
		subtitle: "租户实例会按剩余内存最多的活动节点放置。没有节点时使用 Hub 所在机器的 Docker。",
		register: "注册节点",
		name: "名称",
		dockerUrl: "Docker 地址",
		dockerUrlHint: "例如 tcp://10.0.0.5:2376 或 unix:///var/run/docker.sock",
		tlsDir: "TLS 证书目录（可选）",
		cpu: "CPU 容量（核）",
		mem: "内存容量（MB）",
		memHint: "至少 256",
		invalidName: "请填写名称",
		invalidDockerUrl: "请填写 Docker 地址",
		invalidCpu: "CPU 容量必须是 0 到 4096 之间的数",
		invalidMem: "内存容量必须是不小于 256 的整数",
		status: "状态",
		capacity: "容量",
		tenants: "实例",
		lastPing: "最近检查",
		active: "可用",
		draining: "排空中",
		offline: "离线",
		never: "从未",
		none: "还没有执行节点",
		noneHint: "租户实例现在运行在 Hub 所在机器的 Docker 上。注册节点后，新实例会分配到节点上。",
		check: "检查连接",
		checkOk: "{name} 连接正常",
		checkFail: "{name} 无法连接",
		drain: "排空",
		activate: "重新启用",
		remove: "移除",
		removeNamed: "管理 {name}",
		cpuUsed: "CPU {used} / {total} 核",
		memUsed: "内存 {used} / {total}",
		count: "共 {n} 个节点",
		operatorOnly: "只有运营者可以管理执行节点。",
		drainHint: "排空后不再接收新实例，已有实例继续运行。",
	},
	en: {
		title: "Executor nodes",
		subtitle: "Tenant instances go to the active node with the most free memory. With no nodes, the Hub machine's own Docker is used.",
		register: "Register node",
		name: "Name",
		dockerUrl: "Docker address",
		dockerUrlHint: "For example tcp://10.0.0.5:2376 or unix:///var/run/docker.sock",
		tlsDir: "TLS certificate directory (optional)",
		cpu: "CPU capacity (cores)",
		mem: "Memory capacity (MB)",
		memHint: "At least 256",
		invalidName: "Enter a name",
		invalidDockerUrl: "Enter the Docker address",
		invalidCpu: "CPU capacity must be a number between 0 and 4096",
		invalidMem: "Memory capacity must be a whole number of at least 256",
		status: "Status",
		capacity: "Capacity",
		tenants: "Instances",
		lastPing: "Last check",
		active: "Active",
		draining: "Draining",
		offline: "Offline",
		never: "Never",
		none: "No executor nodes yet",
		noneHint: "Tenant instances currently run on the Hub machine's Docker. Once a node is registered, new instances are placed on nodes.",
		check: "Check connection",
		checkOk: "{name} is reachable",
		checkFail: "{name} cannot be reached",
		drain: "Drain",
		activate: "Re-enable",
		remove: "Remove",
		removeNamed: "Manage {name}",
		cpuUsed: "CPU {used} / {total} cores",
		memUsed: "Memory {used} / {total}",
		count: "{n} nodes",
		operatorOnly: "Only the operator can manage executor nodes.",
		drainHint: "A draining node takes no new instances; running ones continue.",
	},
});

const FIELD_KEY = { name: "invalidName", dockerUrl: "invalidDockerUrl", cpuCapacity: "invalidCpu", memCapacityMb: "invalidMem" } as const;
const TONE: Record<NodeStatus, "moss" | "ember" | "muted"> = { active: "moss", draining: "ember", offline: "muted" };

function LoadBar({ pct, label }: { pct: number; label: string }) {
	const tone = loadTone(pct);
	const color = tone === "rose" ? "bg-rose-400" : tone === "ember" ? "bg-ember-400" : "bg-moss-400";
	return (
		<div className="min-w-32">
			<div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-ink-800">
				<div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
			</div>
			<p className="mt-1 text-[11px] text-ink-400">{label}</p>
		</div>
	);
}

export function NodesPage() {
	const { api, me } = useTeam();
	const t = useT(M);
	const c = useCommonT();
	const lang = usePrefs((s) => s.lang);
	const operator = isOperator(me);
	const list = useAsync(() => (operator ? api.listNodes() : Promise.resolve([] as NodeView[])), [api, operator]);
	const [form, setForm] = useState<NodeForm>(EMPTY_NODE_FORM);
	const [invalid, setInvalid] = useState<string | undefined>(undefined);
	const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | undefined>(undefined);
	const { busy, error, run } = useAction();

	if (!operator) return <ErrorBox message={t("operatorOnly")} />;

	const set = (patch: Partial<NodeForm>) => {
		setInvalid(undefined);
		setForm((f) => ({ ...f, ...patch }));
	};

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		const parsed = nodeInputFromForm(form);
		if (!parsed.ok) return setInvalid(t(FIELD_KEY[parsed.field]));
		if (await run(() => api.createNode(parsed.input))) {
			setForm(EMPTY_NODE_FORM);
			list.reload();
		}
	};

	const act = async (fn: () => Promise<unknown>) => {
		setNote(undefined);
		if ((await run(fn)) !== undefined) list.reload();
	};

	const check = async (node: NodeView) => {
		setNote(undefined);
		const r = await run(() => api.pingNode(node.id));
		if (r) setNote({ kind: r.ok ? "ok" : "error", text: t(r.ok ? "checkOk" : "checkFail", { name: node.name }) });
		list.reload();
	};

	return (
		<>
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<Body className="space-y-4">
				<Card title={t("register")}>
					<form onSubmit={submit} className="grid gap-3 @xl:grid-cols-2">
						<Field label={t("name")}>
							<Input value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} autoComplete="off" required />
						</Field>
						<Field label={t("dockerUrl")} hint={t("dockerUrlHint")}>
							<Input value={form.dockerUrl} onChange={(e) => set({ dockerUrl: e.target.value })} maxLength={500} autoComplete="off" required className="font-mono" placeholder="tcp://10.0.0.5:2376" />
						</Field>
						<Field label={t("tlsDir")}>
							<Input value={form.tlsDir} onChange={(e) => set({ tlsDir: e.target.value })} maxLength={500} autoComplete="off" className="font-mono" />
						</Field>
						<div className="grid grid-cols-2 gap-3">
							<Field label={t("cpu")}>
								<Input value={form.cpuCapacity} onChange={(e) => set({ cpuCapacity: e.target.value })} inputMode="decimal" autoComplete="off" />
							</Field>
							<Field label={t("mem")} hint={t("memHint")}>
								<Input value={form.memCapacityMb} onChange={(e) => set({ memCapacityMb: e.target.value })} inputMode="numeric" autoComplete="off" />
							</Field>
						</div>
						<div className="flex flex-wrap items-center gap-3 @xl:col-span-2">
							<Button type="submit" variant="primary" disabled={busy}>
								<Plus className="size-4" aria-hidden /> {t("register")}
							</Button>
							{invalid && <Notice kind="error">{invalid}</Notice>}
							{error && <Notice kind="error">{error}</Notice>}
						</div>
					</form>
				</Card>

				{note && <Notice kind={note.kind}>{note.text}</Notice>}

				<AsyncView state={list}>
					{(nodes) =>
						nodes.length === 0 ? (
							<Empty icon={<Server className="size-5" />} title={t("none")}>
								{t("noneHint")}
							</Empty>
						) : (
							<div className="space-y-2">
								<p className="text-xs text-ink-500">
									{t("count", { n: nodes.length })} · {t("drainHint")}
								</p>
								<Table label={t("title")} head={[t("name"), t("status"), t("capacity"), t("tenants"), t("lastPing"), ""]}>
									{nodes.map((n) => {
										const load = nodeLoad(n);
										return (
											<tr key={n.id}>
												<Td>
													<p className="font-medium text-ink-100">{n.name}</p>
													<p className="font-mono text-xs break-all text-ink-500">{n.dockerUrl}</p>
												</Td>
												<Td>
													<Badge tone={TONE[n.status]}>{t(n.status)}</Badge>
												</Td>
												<Td>
													<div className="space-y-2">
														<LoadBar pct={load.cpuPct} label={t("cpuUsed", { used: n.allocatedCpu, total: n.cpuCapacity })} />
														<LoadBar pct={load.memPct} label={t("memUsed", { used: formatMem(n.allocatedMemMb), total: formatMem(n.memCapacityMb) })} />
													</div>
												</Td>
												<Td className="text-ink-300">{n.tenants.length}</Td>
												<Td className="text-xs text-ink-400">{n.lastPingAt ? shortDate(n.lastPingAt, lang) : t("never")}</Td>
												<Td className="text-right">
													<span role="group" aria-label={t("removeNamed", { name: n.name })} className="inline-flex flex-wrap justify-end gap-1.5">
														<Button variant="ghost" disabled={busy} onClick={() => void check(n)}>
															{t("check")}
														</Button>
														{n.status === "active" ? (
															<ConfirmButton label={t("drain")} confirmLabel={c("confirm")} variant="danger" disabled={busy} onConfirm={() => void act(() => api.drainNode(n.id))} />
														) : (
															<Button variant="outline" disabled={busy} onClick={() => void act(() => api.updateNode(n.id, { status: "active" }))}>
																{t("activate")}
															</Button>
														)}
														<ConfirmButton label={t("remove")} disabled={busy} onConfirm={() => void act(() => api.deleteNode(n.id))} />
													</span>
												</Td>
											</tr>
										);
									})}
								</Table>
							</div>
						)
					}
				</AsyncView>
			</Body>
		</>
	);
}
