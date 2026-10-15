import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionPrompt, UIRequest } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { respondUI, useStore } from "../lib/store.ts";
import { Button, Input, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		request: "扩展请求",
		cancel: "取消",
		confirm: "确认",
		submit: "提交",
		permission: "需要权限",
		fromSession: "来自会话「{name}」",
		allow: "允许",
		deny: "拒绝",
		always: "始终允许 {rule}",
		runTool: "工具「{tool}」请求执行",
		runCommand: "请求执行命令",
		editFile: "请求修改文件",
		writeFile: "请求写入文件",
		planTitle: "审阅计划",
		planHint: "Agent 已完成调研，批准后才会开始修改。",
		planAcceptEdits: "批准并自动编辑",
		planDefault: "批准，逐项确认",
		planKeep: "继续规划",
	},
	en: {
		request: "Extension request",
		cancel: "Cancel",
		confirm: "Confirm",
		submit: "Submit",
		permission: "Permission needed",
		fromSession: "From chat \"{name}\"",
		allow: "Allow",
		deny: "Deny",
		always: "Always allow {rule}",
		runTool: "Tool \"{tool}\" wants to run",
		runCommand: "Wants to run a command",
		editFile: "Wants to edit a file",
		writeFile: "Wants to write a file",
		planTitle: "Review the plan",
		planHint: "The agent finished researching; nothing changes until you approve.",
		planAcceptEdits: "Approve, auto-accept edits",
		planDefault: "Approve, ask for each action",
		planKeep: "Keep planning",
	},
});

/** Renders blocking extension UI requests (select / confirm / input / editor / permission) as modal dialogs. */
export function DialogHost() {
	const head = useStore((s) => s.uiQueue[0]);
	if (!head) return null;
	if (head.request.method === "permission") return <PermissionDialog key={head.request.id} sessionId={head.sessionId} id={head.request.id} prompt={head.request} />;
	return <Dialog key={head.request.id} sessionId={head.sessionId} request={head.request} />;
}

function PermissionDialog({ sessionId, id, prompt }: { sessionId: string; id: string; prompt: PermissionPrompt }) {
	const t = useT(M);
	const owner = useStore((s) => s.sessions.find((x) => x.id === sessionId));
	const answer = (value: string) => void respondUI(sessionId, id, { value });
	const deny = () => answer(prompt.kind === "plan" ? "keep" : "deny");
	const name = owner?.name || owner?.firstMessage || sessionId.slice(0, 8);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && deny();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	let heading: string;
	if (prompt.kind === "plan") heading = t("planTitle");
	else if (prompt.toolName === "bash" || prompt.toolName === "powershell") heading = t("runCommand");
	else if (prompt.toolName === "edit") heading = t("editFile");
	else if (prompt.toolName === "write") heading = t("writeFile");
	else heading = t("runTool", { tool: prompt.toolName });

	return (
		<div className="fixed inset-0 z-40 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal>
			<div className="flex max-h-[88vh] w-full max-w-2xl animate-rise flex-col rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl shadow-black/60">
				<div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10.5px] tracking-widest text-ember-400 uppercase">
					<span>{t("permission")}</span>
					<span className="min-w-0 truncate text-ink-500 normal-case">{t("fromSession", { name })}</span>
				</div>
				<h2 className="font-display text-lg font-semibold">{heading}</h2>

				{prompt.kind === "plan" ? (
					<>
						<p className="mt-1 text-xs text-ink-500">{t("planHint")}</p>
						<div className="prose-forge mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-ink-800 bg-ink-950/50 p-4">
							<ReactMarkdown remarkPlugins={[remarkGfm]}>{prompt.plan}</ReactMarkdown>
						</div>
						<div className="mt-4 flex flex-wrap justify-end gap-2">
							<Button variant="outline" onClick={() => answer("keep")}>
								{t("planKeep")}
							</Button>
							<Button variant="outline" onClick={() => answer("default")}>
								{t("planDefault")}
							</Button>
							<Button variant="primary" autoFocus onClick={() => answer("acceptEdits")}>
								{t("planAcceptEdits")}
							</Button>
						</div>
					</>
				) : (
					<>
						<pre className="mt-3 overflow-x-auto rounded-lg border border-ink-800 bg-ink-950/60 px-3.5 py-2.5 font-mono text-[13px] break-all whitespace-pre-wrap text-ink-100">{prompt.summary}</pre>
						{prompt.detail && (
							<pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-ink-800 bg-ink-950/40 px-3.5 py-2.5 font-mono text-xs whitespace-pre-wrap text-ink-400">{prompt.detail}</pre>
						)}
						<div className="mt-4 flex flex-wrap items-center justify-end gap-2">
							<Button variant="outline" onClick={deny}>
								{t("deny")}
							</Button>
							{prompt.alwaysLabel && (
								<Button variant="outline" onClick={() => answer("always")}>
									{t("always", { rule: prompt.alwaysLabel })}
								</Button>
							)}
							<Button variant="primary" autoFocus onClick={() => answer("allow")}>
								{t("allow")}
							</Button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function Dialog({ sessionId, request }: { sessionId: string; request: UIRequest }) {
	const t = useT(M);
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	const cancel = () => void respondUI(sessionId, request.id, { cancelled: true });

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const title = "title" in request ? request.title : "";

	return (
		<div className="fixed inset-0 z-40 grid place-items-center bg-ink-950/70 p-4 backdrop-blur-sm" role="dialog" aria-modal>
			<div className="w-full max-w-lg animate-rise rounded-2xl border border-ink-700 bg-ink-900 p-5 shadow-2xl shadow-black/60">
				<div className="mb-1 font-mono text-[10.5px] tracking-widest text-ember-400 uppercase">{t("request")}</div>
				<h2 className="font-display text-lg font-semibold">{title}</h2>

				{request.method === "confirm" && (
					<>
						<p className="mt-2 text-sm whitespace-pre-wrap text-ink-300">{request.message}</p>
						<div className="mt-5 flex justify-end gap-2">
							<Button variant="outline" onClick={() => void respondUI(sessionId, request.id, { confirmed: false })}>
								{t("cancel")}
							</Button>
							<Button variant="primary" autoFocus onClick={() => void respondUI(sessionId, request.id, { confirmed: true })}>
								{t("confirm")}
							</Button>
						</div>
					</>
				)}

				{request.method === "select" && (
					<div className="mt-4 max-h-80 space-y-1 overflow-y-auto">
						{request.options.map((o, i) => (
							<button
								key={o}
								type="button"
								autoFocus={i === 0}
								onClick={() => void respondUI(sessionId, request.id, { value: o })}
								className="w-full rounded-lg border border-ink-800 px-3.5 py-2.5 text-left text-sm text-ink-200 hover:border-ember-500/40 hover:bg-ink-850 focus:border-ember-500/60 focus:outline-none"
							>
								{o}
							</button>
						))}
					</div>
				)}

				{(request.method === "input" || request.method === "editor") && (
					<form
						className="mt-4 space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							void respondUI(sessionId, request.id, { value });
						}}
					>
						{request.method === "input" ? (
							<Input autoFocus value={value} placeholder={request.placeholder} onChange={(e) => setValue(e.target.value)} />
						) : (
							<Textarea autoFocus rows={12} value={value} onChange={(e) => setValue(e.target.value)} className="font-mono text-xs" />
						)}
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={cancel}>
								{t("cancel")}
							</Button>
							<Button type="submit" variant="primary">
								{t("submit")}
							</Button>
						</div>
					</form>
				)}

				{request.method === "select" && (
					<div className="mt-4 flex justify-end">
						<Button variant="ghost" onClick={cancel}>
							{t("cancel")}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
