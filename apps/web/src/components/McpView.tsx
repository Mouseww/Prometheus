import clsx from "clsx";
import { Cable, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { McpExposure, McpProbeResult, McpServerInfo, McpServerSpec } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast } from "../lib/store.ts";
import { Badge, Button, Empty, Field, Input, PageHeader, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		expCodemode: "代码模式（默认，脚本内调用）",
		expCodemodeShort: "代码模式",
		expDeferred: "按需加载（tool_search）",
		expDeferredShort: "按需加载",
		expDirect: "直接暴露给模型",
		expDirectShort: "直接暴露",
		expHidden: "隐藏",
		title: "MCP 服务器",
		subtitle: "接入 Model Context Protocol 工具服务器：stdio 本地进程或 Streamable HTTP 远程服务",
		addServer: "添加服务器",
		emptyTitle: "还没有 MCP 服务器",
		emptyBody: "添加服务器后，其工具会在新会话及已打开的会话中可用。",
		valuePlaceholder: "value 或 ${ENV_VAR}",
		delete: "删除",
		nameRequired: "请填写名称",
		saved: "已保存 MCP 服务器 {name}",
		confirmDelete: "删除 MCP 服务器「{name}」？",
		deleted: "已删除 {name}",
		newServer: "新建 MCP 服务器",
		close: "关闭",
		readOnly: "该服务器来自 PI 的 mcp.json，此处只读，可测试连接。",
		name: "名称",
		nameHint: "作为工具名前缀，建议使用小写字母、数字与 -",
		type: "类型",
		stdioLabel: "STDIO · 本地进程",
		command: "命令",
		args: "参数",
		argsHint: "每行一个",
		cwd: "工作目录（可选）",
		env: "环境变量",
		secretHint: "可使用 ${ENV_VAR} 引用本机环境变量；掩码值（••••••）保持不变即保留原值",
		headers: "请求头",
		description: "描述",
		descriptionPlaceholder: "提供 GitHub 仓库与 Issue 操作",
		exposure: "暴露方式",
		timeout: "超时（秒，可选）",
		enable: "启用此服务器",
		testOk: "连接成功",
		testFail: "连接失败",
		hotReload: "保存后会热重载所有活动会话中的 MCP 连接。",
		test: "测试连接",
		save: "保存",
	},
	en: {
		expCodemode: "Code mode (default, called from scripts)",
		expCodemodeShort: "Code mode",
		expDeferred: "On demand (tool_search)",
		expDeferredShort: "On demand",
		expDirect: "Expose directly to the model",
		expDirectShort: "Direct",
		expHidden: "Hidden",
		title: "MCP Servers",
		subtitle: "Connect Model Context Protocol tool servers: local stdio processes or remote Streamable HTTP services",
		addServer: "Add server",
		emptyTitle: "No MCP servers yet",
		emptyBody: "Once added, a server's tools become available in new and open sessions.",
		valuePlaceholder: "value or ${ENV_VAR}",
		delete: "Delete",
		nameRequired: "Please enter a name",
		saved: "Saved MCP server {name}",
		confirmDelete: "Delete MCP server \"{name}\"?",
		deleted: "Deleted {name}",
		newServer: "New MCP server",
		close: "Close",
		readOnly: "This server comes from PI's mcp.json. It's read-only here, but you can test the connection.",
		name: "Name",
		nameHint: "Used as the tool name prefix; lowercase letters, digits and - recommended",
		type: "Type",
		stdioLabel: "STDIO · Local process",
		command: "Command",
		args: "Arguments",
		argsHint: "One per line",
		cwd: "Working directory (optional)",
		env: "Environment variables",
		secretHint: "Use ${ENV_VAR} to reference local environment variables; leave masked values (••••••) unchanged to keep them",
		headers: "Headers",
		description: "Description",
		descriptionPlaceholder: "GitHub repository and issue operations",
		exposure: "Exposure",
		timeout: "Timeout (seconds, optional)",
		enable: "Enable this server",
		testOk: "Connected",
		testFail: "Connection failed",
		hotReload: "Saving hot-reloads MCP connections in all active sessions.",
		test: "Test connection",
		save: "Save",
	},
});
type MsgKey = keyof typeof M.zh;

const EXPOSURE: { value: McpExposure; label: MsgKey; short: MsgKey }[] = [
	{ value: "codemode", label: "expCodemode", short: "expCodemodeShort" },
	{ value: "deferred", label: "expDeferred", short: "expDeferredShort" },
	{ value: "direct", label: "expDirect", short: "expDirectShort" },
	{ value: "hidden", label: "expHidden", short: "expHidden" },
];

type Pairs = [string, string][];

const toPairs = (r?: Record<string, string>): Pairs => Object.entries(r ?? {});
const fromPairs = (p: Pairs): Record<string, string> | undefined => {
	const rows = p.filter(([k]) => k.trim()).map(([k, v]): [string, string] => [k.trim(), v]);
	return rows.length ? Object.fromEntries(rows) : undefined;
};

export function McpView() {
	const t = useT(M);
	const [list, setList] = useState<McpServerInfo[]>([]);
	const [editing, setEditing] = useState<{ info: McpServerInfo; isNew: boolean } | null>(null);

	const load = async () => {
		const servers = await pluginCall<McpServerInfo[]>("mcp", "list");
		if (servers) setList(servers);
	};
	useEffect(() => {
		void load();
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={t("title")}
				subtitle={t("subtitle")}
				actions={
					<Button variant="primary" onClick={() => setEditing({ info: { name: "", source: "prometheus", spec: { type: "stdio", args: [], exposure: "codemode", enabled: true } }, isNew: true })}>
						<Plus className="size-4" /> {t("addServer")}
					</Button>
				}
			/>
			<div className="flex min-h-0 flex-1">
				<div className={clsx("min-h-0 overflow-y-auto p-6", editing ? "hidden w-96 shrink-0 border-r hairline lg:block" : "flex-1")}>
					{list.length === 0 ? (
						<Empty icon={<Cable className="size-5" />} title={t("emptyTitle")}>
							{t("emptyBody")}
						</Empty>
					) : (
						<div className={clsx("grid gap-3", !editing && "md:grid-cols-2 xl:grid-cols-3")}>
							{list.map((s) => (
								<button
									key={`${s.source}:${s.name}`}
									type="button"
									onClick={() => setEditing({ info: structuredClone(s), isNew: false })}
									className={clsx(
										"group animate-rise rounded-xl border bg-ink-900/60 p-4 text-left transition-colors hover:border-ink-600",
										editing && !editing.isNew && editing.info.name === s.name && editing.info.source === s.source ? "border-ember-500/50" : "border-ink-800",
									)}
								>
									<div className="flex items-center gap-2">
										<span className={clsx("size-2 rounded-full", s.spec.enabled === false ? "bg-ink-600" : "bg-moss-400")} />
										<span className="truncate font-display font-semibold">{s.name}</span>
										{s.source === "pi" && <Badge tone="sky">PI</Badge>}
									</div>
									<div className="mt-1 truncate font-mono text-xs text-ink-500">
										{s.spec.type === "http" ? s.spec.url : [s.spec.command, ...(s.spec.args ?? [])].join(" ")}
									</div>
									{s.spec.description && <div className="mt-2 line-clamp-2 text-xs text-ink-400">{s.spec.description}</div>}
									<div className="mt-3 flex flex-wrap gap-1.5">
										<Badge tone="ember">{s.spec.type === "http" ? "HTTP" : "STDIO"}</Badge>
										<Badge>{t(EXPOSURE.find((e) => e.value === (s.spec.exposure ?? "codemode"))?.short ?? "expCodemodeShort")}</Badge>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
				{editing && (
					<McpEditor
						key={editing.isNew ? "new" : `${editing.info.source}:${editing.info.name}`}
						initial={editing.info}
						isNew={editing.isNew}
						onClose={() => setEditing(null)}
						onSaved={load}
					/>
				)}
			</div>
		</div>
	);
}

function PairRows({ rows, onChange, keyPlaceholder, label }: { rows: Pairs; onChange: (p: Pairs) => void; keyPlaceholder: string; label: string }) {
	const t = useT(M);
	return (
		<div className="space-y-2">
			{rows.map(([k, v], i) => (
				<div key={i} className="flex gap-2">
					<Input value={k} placeholder={keyPlaceholder} onChange={(e) => onChange(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} className="font-mono" />
					<Input value={v} placeholder={t("valuePlaceholder")} onChange={(e) => onChange(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} className="font-mono" />
					<Button variant="danger" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={t("delete")}>
						<Trash2 className="size-4" />
					</Button>
				</div>
			))}
			<Button variant="outline" onClick={() => onChange([...rows, ["", ""]])}>
				<Plus className="size-3.5" /> {label}
			</Button>
		</div>
	);
}

function McpEditor({ initial, isNew, onClose, onSaved }: { initial: McpServerInfo; isNew: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
	const t = useT(M);
	const readOnly = initial.source === "pi";
	const [name, setName] = useState(initial.name);
	const [spec, setSpec] = useState<McpServerSpec>(initial.spec);
	const [args, setArgs] = useState((initial.spec.args ?? []).join("\n"));
	const [env, setEnv] = useState<Pairs>(toPairs(initial.spec.env));
	const [headers, setHeaders] = useState<Pairs>(toPairs(initial.spec.headers));
	const [busy, setBusy] = useState(false);
	const [test, setTest] = useState<McpProbeResult | null>(null);
	const patch = (p: Partial<McpServerSpec>) => setSpec((s) => ({ ...s, ...p }));

	const build = (): McpServerSpec => {
		const base: McpServerSpec = {
			type: spec.type,
			description: spec.description?.trim() || undefined,
			exposure: spec.exposure ?? "codemode",
			enabled: spec.enabled !== false,
			timeout: spec.timeout,
		};
		if (spec.type === "http") return { ...base, url: spec.url?.trim(), headers: fromPairs(headers) };
		return {
			...base,
			command: spec.command?.trim(),
			args: args.split("\n").map((a) => a.trim()).filter(Boolean),
			cwd: spec.cwd?.trim() || undefined,
			env: fromPairs(env),
		};
	};

	const save = async () => {
		const trimmed = name.trim();
		if (!trimmed) return toast(t("nameRequired"), "warning");
		setBusy(true);
		const res = await pluginCall<null>("mcp", "save", { name: trimmed, previousName: isNew ? undefined : initial.name, spec: build() });
		setBusy(false);
		if (res === undefined) return;
		toast(t("saved", { name: trimmed }));
		await onSaved();
		onClose();
	};

	const runTest = async () => {
		setTest(null);
		setBusy(true);
		const params = readOnly ? { name: initial.name } : { name: isNew ? undefined : initial.name, spec: build() };
		const result = await pluginCall<McpProbeResult>("mcp", "probe", params);
		setBusy(false);
		if (result) setTest(result);
	};

	const remove = async () => {
		if (!window.confirm(t("confirmDelete", { name: initial.name }))) return;
		setBusy(true);
		const res = await pluginCall<null>("mcp", "delete", { name: initial.name });
		setBusy(false);
		if (res === undefined) return;
		toast(t("deleted", { name: initial.name }));
		await onSaved();
		onClose();
	};

	const toggle = async (enabled: boolean) => {
		if (isNew || readOnly) return patch({ enabled });
		setBusy(true);
		const res = await pluginCall<null>("mcp", "toggle", { name: initial.name, enabled });
		setBusy(false);
		if (res === undefined) return;
		patch({ enabled });
		await onSaved();
	};

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto max-w-2xl space-y-6 p-6">
				<div className="flex items-center justify-between gap-2">
					<h2 className="flex items-center gap-2 font-display text-xl font-semibold">
						{isNew ? t("newServer") : initial.name}
						{readOnly && <Badge tone="sky">PI</Badge>}
					</h2>
					<Button onClick={onClose}>{t("close")}</Button>
				</div>

				{readOnly && (
					<div className="rounded-lg border border-sky-400/30 bg-sky-400/8 px-3.5 py-2.5 text-sm text-sky-400">{t("readOnly")}</div>
				)}

				<fieldset disabled={readOnly} className="space-y-6">
					<Field label={t("name")} hint={t("nameHint")}>
						<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" className="font-mono" />
					</Field>

					<Field label={t("type")}>
						<div className="grid grid-cols-2 gap-2">
							{(["stdio", "http"] as const).map((k) => (
								<button
									key={k}
									type="button"
									onClick={() => patch({ type: k })}
									className={clsx(
										"rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
										spec.type === k ? "border-ember-500/60 bg-ember-500/8 text-ink-100" : "border-ink-700 text-ink-400 hover:border-ink-500",
									)}
								>
									{k === "stdio" ? t("stdioLabel") : "HTTP · Streamable HTTP"}
								</button>
							))}
						</div>
					</Field>

					{spec.type === "stdio" ? (
						<>
							<Field label={t("command")}>
								<Input value={spec.command ?? ""} onChange={(e) => patch({ command: e.target.value })} placeholder="npx" className="font-mono" />
							</Field>
							<Field label={t("args")} hint={t("argsHint")}>
								<Textarea rows={4} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-github"} className="font-mono" />
							</Field>
							<Field label={t("cwd")}>
								<Input value={spec.cwd ?? ""} onChange={(e) => patch({ cwd: e.target.value })} className="font-mono" />
							</Field>
							<Field label={t("env")} hint={t("secretHint")}>
								<PairRows rows={env} onChange={setEnv} keyPlaceholder="KEY" label={t("env")} />
							</Field>
						</>
					) : (
						<>
							<Field label="URL">
								<Input value={spec.url ?? ""} onChange={(e) => patch({ url: e.target.value })} placeholder="https://example.com/mcp" className="font-mono" />
							</Field>
							<Field label={t("headers")} hint={t("secretHint")}>
								<PairRows rows={headers} onChange={setHeaders} keyPlaceholder="Authorization" label={t("headers")} />
							</Field>
						</>
					)}

					<Field label={t("description")}>
						<Textarea rows={2} value={spec.description ?? ""} onChange={(e) => patch({ description: e.target.value })} placeholder={t("descriptionPlaceholder")} />
					</Field>

					<div className="grid gap-4 sm:grid-cols-2">
						<Field label={t("exposure")}>
							<Select value={spec.exposure ?? "codemode"} onChange={(e) => patch({ exposure: e.target.value as McpExposure })}>
								{EXPOSURE.map((x) => (
									<option key={x.value} value={x.value}>
										{t(x.label)}
									</option>
								))}
							</Select>
						</Field>
						<Field label={t("timeout")}>
							<Input
								type="number"
								min={1}
								value={spec.timeout ?? ""}
								onChange={(e) => patch({ timeout: e.target.value ? Number(e.target.value) : undefined })}
								className="font-mono"
							/>
						</Field>
					</div>
				</fieldset>

				<label className="flex items-center gap-2 text-sm text-ink-300">
					<input type="checkbox" disabled={busy || readOnly} checked={spec.enabled !== false} onChange={(e) => void toggle(e.target.checked)} className="accent-ember-500" />
					{t("enable")}
				</label>

				{test && (
					<div className={clsx("rounded-lg border px-3.5 py-2.5 text-sm", test.ok ? "border-moss-400/30 bg-moss-400/8 text-moss-400" : "border-rose-400/30 bg-rose-400/8 text-rose-400")}>
						{test.ok ? t("testOk") : t("testFail")} · {test.latencyMs}ms{test.server ? ` · ${test.server}` : ""}
						{test.error && <div className="mt-1 font-mono text-xs break-all opacity-80">{test.error}</div>}
						{test.tools.length > 0 && (
							<div className="mt-2 flex flex-wrap gap-1.5">
								{test.tools.map((tool) => (
									<span key={tool.name} title={tool.description} className="rounded-md bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-300">
										{tool.name}
									</span>
								))}
							</div>
						)}
					</div>
				)}

				<p className="text-xs text-ink-500">{t("hotReload")}</p>

				<div className="flex items-center gap-2 border-t hairline pt-5">
					{!isNew && !readOnly && (
						<Button variant="danger" disabled={busy} onClick={() => void remove()}>
							<Trash2 className="size-4" /> {t("delete")}
						</Button>
					)}
					<div className="flex-1" />
					<Button variant="outline" disabled={busy} onClick={() => void runTest()}>
						<Zap className="size-4" /> {t("test")}
					</Button>
					{!readOnly && (
						<Button variant="primary" disabled={busy} onClick={() => void save()}>
							{t("save")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
