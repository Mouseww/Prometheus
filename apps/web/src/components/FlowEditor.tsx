import clsx from "clsx";
import {
	AlarmClock,
	ArrowLeft,
	Bot,
	CircleAlert,
	CircleStop,
	Flag,
	GitBranch,
	LayoutGrid,
	LoaderCircle,
	Maximize,
	MessageSquare,
	Minus,
	Play,
	Plus,
	Redo2,
	Save,
	Sparkles,
	Trash2,
	Undo2,
	Workflow,
	X,
	Zap,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Flow, type FlowEdge, type FlowInput, type FlowIssue, type FlowNode, type FlowNodeKind, type FlowNodeRun, type FlowRun, flowIssues, type RunAccess } from "@prometheus/protocol";
import { confirmDialog } from "../lib/dialogs.ts";
import { layoutFlow, NODE_H, NODE_W, runProgress } from "../lib/flowLayout.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { usePrefs } from "../lib/prefs.ts";
import { openSession, pluginCall, toast, useStore } from "../lib/store.ts";
import { LocationField, placeLabel, useDefaultLocation } from "./FlowLocation.tsx";
import { describeSchedule, ScheduleDialog } from "./FlowSchedule.tsx";
import { Badge, Button, Dialog, Field, Input, Select, Textarea } from "./ui.tsx";

const M = defineMessages({
	zh: {
		back: "返回",
		name: "流程名称",
		desc: "说明（这条 SOP 解决什么问题）",
		workspace: "工作区",
		general: "通用流程（不绑定项目）",
		bindHint: "绑定到项目后只能在该项目里运行；通用流程可在任何项目或个人空间运行",
		ranIn: "位置：{place}",
		save: "保存",
		saved: "已保存",
		run: "运行",
		stop: "停止",
		runInput: "运行输入",
		runInputHint: "启动时传给流程的内容，步骤里用 {{input}} 引用。可留空。",
		start: "开始运行",
		cancel: "取消",
		addAgent: "Agent 步骤",
		addCondition: "条件分支",
		addEnd: "结束",
		layout: "自动排版",
		palette: "添加",
		dragHint: "拖动节点移动 · 拖右侧圆点到另一个节点连线 · 拖空白处平移 · Ctrl+滚轮缩放",
		kindStart: "开始",
		kindAgent: "Agent",
		kindCondition: "条件",
		kindEnd: "结束",
		kindSubflow: "子流程",
		addSubflow: "子流程",
		subflowPick: "要调用的流程",
		subflowNone: "选择一条流程…",
		subflowInput: "传给子流程的输入",
		subflowInputPh: "留空则传入上游输出（{{prev}}）；也可写 {{input}}、{{节点ID}}",
		subflowOutput: "子流程的最终输出会成为这个节点的输出，后面可以用 {{节点ID}} 引用。",
		subflowOpen: "打开子流程",
		subflowSteps: "子流程进度",
		subflowLeave: "有未保存的修改，先离开当前流程？",
		inspector: "节点设置",
		pick: "选中一个节点来编辑它",
		title: "标题",
		prompt: "指令",
		promptPh: "这一步要做什么。可用 {{input}} 启动输入、{{prev}} 上游输出、{{节点ID}} 指定节点输出",
		question: "判断问题",
		questionPh: "例如：上面的测试是否全部通过？",
		access: "权限",
		readonly: "只读",
		edits: "可编辑",
		full: "完全",
		model: "模型",
		modelDefault: "默认模型",
		condMode: "判断方式",
		condAi: "让 Agent 判断是/否",
		condContains: "上游输出包含文字",
		condRegex: "上游输出匹配正则",
		match: "匹配内容",
		deleteNode: "删除节点",
		deleteEdge: "删除连线",
		nodeId: "节点 ID：{id}（提示词里用 {ref} 引用它的输出）",
		output: "输出",
		openChat: "查看会话",
		yes: "是",
		no: "否",
		unsaved: "未保存",
		confirmLeave: "有未保存的修改，确定离开？",
		success: "成功",
		failed: "失败",
		skipped: "已跳过",
		cancelled: "已取消",
		pending: "等待",
		running: "运行中",
		runResult: "运行结果",
		aiEdit: "AI 修改",
		aiEditTitle: "让 AI 调整当前流程",
		aiEditPh: "例如：在测试之后加一个代码审查步骤；把第二步改成可编辑权限",
		generating: "生成中…（可能需要一两分钟）",
		generate: "生成",
		replaced: "已按描述调整，请检查后保存（可 Ctrl+Z 撤销）",
		step: "步骤",
		undo: "撤销 (Ctrl+Z)",
		redo: "重做 (Ctrl+Shift+Z)",
		zoomIn: "放大",
		zoomOut: "缩小",
		fit: "适应画面",
		schedule: "定时",
		issues: "{n} 个问题需要处理",
		issueGo: "点击定位",
		stepOf: "步骤 {done}/{total}",
		current: "正在：{name}",
		took: "用时 {t}",
		viaSchedule: "定时触发",
		viaAgent: "对话触发",
		runDone: "运行完成",
		runFailed: "运行失败",
		runCancelled: "运行已取消",
		lastRun: "最近一次运行",
		sessions: "查看会话",
	},
	en: {
		back: "Back",
		name: "Flow name",
		desc: "Description (what this SOP is for)",
		workspace: "Workspace",
		general: "General (no project)",
		bindHint: "Bound to a project, the flow only runs there; a general flow runs in any project or the personal space",
		ranIn: "In: {place}",
		save: "Save",
		saved: "Saved",
		run: "Run",
		stop: "Stop",
		runInput: "Run input",
		runInputHint: "Passed to the flow at start; steps reference it as {{input}}. May be empty.",
		start: "Start run",
		cancel: "Cancel",
		addAgent: "Agent step",
		addCondition: "Condition",
		addEnd: "End",
		layout: "Auto layout",
		palette: "Add",
		dragHint: "Drag nodes · drag the right dot onto a node to connect · drag the background to pan · Ctrl+wheel to zoom",
		kindStart: "Start",
		kindAgent: "Agent",
		kindCondition: "Condition",
		kindEnd: "End",
		kindSubflow: "Subflow",
		addSubflow: "Subflow",
		subflowPick: "Flow to call",
		subflowNone: "Choose a flow…",
		subflowInput: "Input for the subflow",
		subflowInputPh: "Empty passes the upstream output ({{prev}}); {{input}} and {{nodeId}} work too",
		subflowOutput: "The subflow's final output becomes this node's output; use {{nodeId}} later to reference it.",
		subflowOpen: "Open subflow",
		subflowSteps: "Subflow progress",
		subflowLeave: "You have unsaved changes. Leave this flow first?",
		inspector: "Node settings",
		pick: "Select a node to edit it",
		title: "Title",
		prompt: "Instruction",
		promptPh: "What this step does. Use {{input}} for the start input, {{prev}} for upstream output, {{nodeId}} for a given node's output",
		question: "Question",
		questionPh: "e.g. Did all the tests above pass?",
		access: "Permission",
		readonly: "Read-only",
		edits: "Edits",
		full: "Full",
		model: "Model",
		modelDefault: "Default model",
		condMode: "How to decide",
		condAi: "Ask the agent yes/no",
		condContains: "Upstream output contains text",
		condRegex: "Upstream output matches regex",
		match: "Match",
		deleteNode: "Delete node",
		deleteEdge: "Delete connection",
		nodeId: "Node ID: {id} (use {ref} in prompts to reference its output)",
		output: "Output",
		openChat: "Open chat",
		yes: "Yes",
		no: "No",
		unsaved: "Unsaved",
		confirmLeave: "You have unsaved changes. Leave anyway?",
		success: "Done",
		failed: "Failed",
		skipped: "Skipped",
		cancelled: "Cancelled",
		pending: "Waiting",
		running: "Running",
		runResult: "Run result",
		aiEdit: "AI edit",
		aiEditTitle: "Let AI adjust this flow",
		aiEditPh: "e.g. add a code review step after the tests; give step two edit permission",
		generating: "Generating… (may take a minute or two)",
		generate: "Generate",
		replaced: "Adjusted as described; review it, then save (Ctrl+Z undoes it)",
		step: "Step",
		undo: "Undo (Ctrl+Z)",
		redo: "Redo (Ctrl+Shift+Z)",
		zoomIn: "Zoom in",
		zoomOut: "Zoom out",
		fit: "Fit to view",
		schedule: "Schedule",
		issues: "{n} issue(s) to fix",
		issueGo: "Click to locate",
		stepOf: "Step {done}/{total}",
		current: "Now: {name}",
		took: "took {t}",
		viaSchedule: "scheduled",
		viaAgent: "from chat",
		runDone: "Run finished",
		runFailed: "Run failed",
		runCancelled: "Run cancelled",
		lastRun: "Last run",
		sessions: "Open chats",
	},
});

const CANVAS_W = 3000;
const CANVAS_H = 2000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.6;

type Draft = FlowInput & { id?: string };
type Sel = { type: "node"; id: string } | { type: "edge"; id: string } | null;
export type EditorInitial = Draft & Partial<Pick<Flow, "updatedAt" | "nextRunAt">>;

const KIND_ICON: Record<FlowNodeKind, typeof Bot> = { start: Zap, agent: Bot, condition: GitBranch, end: Flag, subflow: Workflow };

export function blankFlow(workspaceId: string): Draft {
	return {
		name: "",
		description: "",
		workspaceId,
		nodes: [
			{ id: "start", kind: "start", x: 60, y: 120, title: "开始" },
			{ id: "a1", kind: "agent", x: 340, y: 120, title: "步骤 1", prompt: "", access: "readonly" },
		],
		edges: [{ id: "e1", from: "start", to: "a1" }],
	};
}

/** Output handle position of an edge's source (condition nodes have a yes and a no handle). */
function outPoint(n: FlowNode, branch?: "true" | "false") {
	const y = n.kind === "condition" ? n.y + (branch === "false" ? NODE_H * 0.74 : NODE_H * 0.26) : n.y + NODE_H / 2;
	return { x: n.x + NODE_W, y };
}

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
	const d = Math.max(40, Math.abs(b.x - a.x) / 2);
	return `M${a.x},${a.y} C${a.x + d},${a.y} ${b.x - d},${b.y} ${b.x},${b.y}`;
}

/** First grid slot in the visible area that no node covers, so a new node never lands on top of another. */
function freeSpot(nodes: FlowNode[], x0: number, y0: number, viewW: number) {
	for (let row = 0; row < 40; row++) {
		for (let col = 0; col * 250 + NODE_W < Math.max(viewW, 700); col++) {
			const x = x0 + col * 250;
			const y = y0 + row * 110;
			if (!nodes.some((n) => Math.abs(n.x - x) < NODE_W + 20 && Math.abs(n.y - y) < NODE_H + 16)) return { x, y };
		}
	}
	return { x: x0, y: y0 };
}

const fmtDur = (ms: number) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

const STATUS_RING: Record<string, string> = {
	running: "flow-node-running border-ember-400",
	success: "border-moss-400/70",
	error: "border-rose-400",
	skipped: "border-ink-700 opacity-45",
};

export function FlowEditor({ initial, runs, flows, onClose, onSaved, onOpenFlow }: { initial: EditorInitial; runs: FlowRun[]; flows: Flow[]; onClose: () => void; onSaved: (flow: Flow) => void; onOpenFlow: (flow: Flow) => void }) {
	const t = useT(M);
	const lang = usePrefs((p) => p.lang);
	const workspaces = useStore((s) => s.workspaces);
	const models = useStore((s) => s.models);
	const [draft, setDraftState] = useState<Draft>(initial);
	const draftRef = useRef<Draft>(initial);
	const [dirty, setDirty] = useState(!initial.id);
	const [sel, setSel] = useState<Sel>(null);
	const [link, setLink] = useState<{ from: string; branch?: "true" | "false"; x: number; y: number } | null>(null);
	const [dialog, setDialog] = useState<"run" | "ai" | "schedule" | null>(null);
	const [busy, setBusy] = useState(false);
	const [zoom, setZoomState] = useState(1);
	const zoomRef = useRef(1);
	const [showIssues, setShowIssues] = useState(false);
	const [meta, setMeta] = useState({ updatedAt: initial.updatedAt ?? "", nextRunAt: initial.nextRunAt });
	const [now, setNow] = useState(Date.now());
	const scroller = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLDivElement>(null);
	const history = useRef<{ past: Draft[]; future: Draft[]; key?: string; at: number }>({ past: [], future: [], at: 0 });
	const [, bump] = useState(0);

	const nodes = draft.nodes;
	const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

	// ----- state with undo/redo -----
	const setDraft = (next: Draft) => {
		draftRef.current = next;
		setDraftState(next);
	};
	/** Applies a change; changes carrying the same key within a second (typing in one field) share one undo step. */
	const edit = (fn: (d: Draft) => Draft, key?: string) => {
		const cur = draftRef.current;
		const next = fn(cur);
		if (next === cur) return;
		const h = history.current;
		const t0 = Date.now();
		if (!(key && h.key === key && t0 - h.at < 1000)) {
			h.past.push(cur);
			if (h.past.length > 100) h.past.shift();
		}
		h.key = key;
		h.at = t0;
		h.future = [];
		setDraft(next);
		setDirty(true);
		bump((n) => n + 1);
	};
	const snapshot = () => {
		const h = history.current;
		h.past.push(draftRef.current);
		if (h.past.length > 100) h.past.shift();
		h.future = [];
		h.key = undefined;
		bump((n) => n + 1);
	};
	const undo = () => {
		const h = history.current;
		const prev = h.past.pop();
		if (!prev) return;
		h.future.push(draftRef.current);
		h.key = undefined;
		setDraft(prev);
		setDirty(true);
		setSel((s) => (s?.type === "node" && !prev.nodes.some((n) => n.id === s.id) ? null : s));
		bump((n) => n + 1);
	};
	const redo = () => {
		const h = history.current;
		const next = h.future.pop();
		if (!next) return;
		h.past.push(draftRef.current);
		h.key = undefined;
		setDraft(next);
		setDirty(true);
		bump((n) => n + 1);
	};
	const patchNode = (id: string, patch: Partial<FlowNode>, key?: string) => edit((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }), key ? `${id}:${key}` : undefined);

	// ----- validation -----
	const issues = useMemo<FlowIssue[]>(() => flowIssues(draft, { selfId: draft.id, flows }), [draft, flows]);
	const issueNodes = useMemo(() => {
		const m = new Map<string, string[]>();
		for (const i of issues) if (i.nodeId) m.set(i.nodeId, [...(m.get(i.nodeId) ?? []), i.message]);
		return m;
	}, [issues]);
	const issueEdges = useMemo(() => new Set(issues.map((i) => i.edgeId).filter(Boolean)), [issues]);
	useEffect(() => {
		if (!issues.length) setShowIssues(false);
	}, [issues.length]);

	// ----- latest run -----
	const run = useMemo(() => (draft.id ? runs.find((r) => r.flowId === draft.id) : undefined), [runs, draft.id]);
	const running = run?.status === "running";
	// A run made before the flow was last saved describes a graph that no longer exists, so it is not painted.
	const paint = run && (running || !meta.updatedAt || new Date(run.startedAt).getTime() >= new Date(meta.updatedAt).getTime()) ? run : undefined;
	useEffect(() => {
		if (!running) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [running]);
	const nodeRun = (id: string) => paint?.nodes[id];
	const childLine = (n: FlowNode, nr?: FlowNodeRun) => {
		const f = flows.find((x) => x.id === n.flowId);
		const child = nr?.childRunId ? runs.find((r) => r.id === nr.childRunId) : undefined;
		if (child && f) {
			const p = runProgress(f.nodes, child);
			return `${f.name} · ${p.done}/${p.total}`;
		}
		return f?.name ?? t("subflowNone");
	};
	const openSub = async (f: Flow) => {
		if (dirty && !(await confirmDialog(t("subflowLeave")))) return;
		onOpenFlow(f);
	};

	// ----- view: zoom, pan, fit -----
	const setZoom = useCallback((z: number, anchor?: { x: number; y: number }) => {
		const el = scroller.current;
		const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
		const prev = zoomRef.current;
		if (el && next !== prev) {
			// Keep the point under the cursor (or the view centre) where it is.
			const ax = anchor?.x ?? el.clientWidth / 2;
			const ay = anchor?.y ?? el.clientHeight / 2;
			const cx = (el.scrollLeft + ax) / prev;
			const cy = (el.scrollTop + ay) / prev;
			zoomRef.current = next;
			setZoomState(next);
			requestAnimationFrame(() => {
				el.scrollLeft = cx * next - ax;
				el.scrollTop = cy * next - ay;
			});
		}
	}, []);
	const fit = useCallback(() => {
		const el = scroller.current;
		const list = draftRef.current.nodes;
		if (!el || !list.length) return;
		const x1 = Math.min(...list.map((n) => n.x));
		const y1 = Math.min(...list.map((n) => n.y));
		const x2 = Math.max(...list.map((n) => n.x + NODE_W));
		const y2 = Math.max(...list.map((n) => n.y + NODE_H));
		const top = 24;
		const availW = el.clientWidth - 100;
		const availH = el.clientHeight - top - 40;
		// Fit, but never smaller than the text stays readable; a wide flow in a narrow window is panned instead.
		const z = Math.min(1, Math.max(0.55, Math.min(availW / (x2 - x1), availH / (y2 - y1))));
		zoomRef.current = z;
		setZoomState(z);
		requestAnimationFrame(() => {
			el.scrollLeft = Math.max(0, x1 * z - Math.max(30, (el.clientWidth - (x2 - x1) * z) / 2));
			el.scrollTop = Math.max(0, y1 * z - top - Math.max(0, (availH - (y2 - y1) * z) / 2));
		});
	}, []);
	const reveal = (id: string) => {
		const el = scroller.current;
		const n = draftRef.current.nodes.find((m) => m.id === id);
		if (!el || !n) return;
		const z = zoomRef.current;
		el.scrollTo({ left: Math.max(0, (n.x + NODE_W / 2) * z - el.clientWidth / 2), top: Math.max(0, (n.y + NODE_H / 2) * z - el.clientHeight / 2), behavior: "smooth" });
	};
	// Fit once the canvas has a real size (the modal animates in, so the first measure can be zero).
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		let done = false;
		const tryFit = () => {
			if (done || el.clientWidth < 100 || el.clientHeight < 100) return;
			done = true;
			fit();
		};
		const ro = new ResizeObserver(tryFit);
		ro.observe(el);
		tryFit();
		return () => ro.disconnect();
	}, [fit]);
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (!(e.ctrlKey || e.metaKey)) return;
			e.preventDefault();
			const r = el.getBoundingClientRect();
			setZoom(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top });
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [setZoom]);

	const toCanvas = (e: { clientX: number; clientY: number }) => {
		const r = canvas.current!.getBoundingClientRect();
		return { x: (e.clientX - r.left) / zoomRef.current, y: (e.clientY - r.top) / zoomRef.current };
	};

	const panStart = (e: ReactPointerEvent) => {
		if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return;
		setSel(null);
		const el = scroller.current!;
		const sx = e.clientX;
		const sy = e.clientY;
		const sl = el.scrollLeft;
		const st = el.scrollTop;
		el.style.cursor = "grabbing";
		const move = (ev: PointerEvent) => {
			el.scrollLeft = sl - (ev.clientX - sx);
			el.scrollTop = st - (ev.clientY - sy);
		};
		const up = () => {
			el.style.cursor = "";
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	// ----- dragging nodes -----
	const dragNode = (e: ReactPointerEvent, n: FlowNode) => {
		if ((e.target as HTMLElement).closest("[data-handle]")) return;
		e.preventDefault();
		e.stopPropagation();
		setSel({ type: "node", id: n.id });
		const start = toCanvas(e);
		const origin = { x: n.x, y: n.y };
		let moved = false;
		const move = (ev: PointerEvent) => {
			const p = toCanvas(ev);
			const x = Math.max(0, Math.min(CANVAS_W - NODE_W, Math.round((origin.x + p.x - start.x) / 10) * 10));
			const y = Math.max(0, Math.min(CANVAS_H - NODE_H, Math.round((origin.y + p.y - start.y) / 10) * 10));
			const cur = draftRef.current;
			const at = cur.nodes.find((m) => m.id === n.id);
			if (!at || (at.x === x && at.y === y)) return;
			if (!moved) {
				moved = true;
				snapshot(); // one undo step per drag
			}
			setDraft({ ...cur, nodes: cur.nodes.map((m) => (m.id === n.id ? { ...m, x, y } : m)) });
			setDirty(true);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	// ----- connecting nodes -----
	const connect = (from: string, to: string, branch?: "true" | "false") => {
		if (from === to) return;
		edit((d) => {
			const target = d.nodes.find((n) => n.id === to);
			if (!target || target.kind === "start") return d;
			if (d.edges.some((e) => e.from === from && e.to === to && e.branch === branch)) return d;
			// A cycle would make the flow unrunnable: refuse a connection that leads back to its own source.
			const reach = new Set<string>([to]);
			for (let grew = true; grew; ) {
				grew = false;
				for (const e of d.edges) if (reach.has(e.from) && !reach.has(e.to)) (reach.add(e.to), (grew = true));
			}
			if (reach.has(from)) {
				toast(lang === "zh" ? "这条连线会形成环，已忽略" : "That connection would make a loop; ignored", "warning");
				return d;
			}
			return { ...d, edges: [...d.edges, { id: `e${Date.now().toString(36)}${d.edges.length}`, from, to, ...(branch ? { branch } : {}) }] };
		});
	};
	const startLink = (e: ReactPointerEvent, n: FlowNode, branch?: "true" | "false") => {
		e.preventDefault();
		e.stopPropagation();
		setLink({ from: n.id, branch, ...outPoint(n, branch) });
		const move = (ev: PointerEvent) => {
			const p = toCanvas(ev);
			setLink({ from: n.id, branch, x: p.x, y: p.y });
		};
		const up = (ev: PointerEvent) => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			setLink(null);
			const p = toCanvas(ev);
			const target = [...draftRef.current.nodes].reverse().find((m) => p.x >= m.x - 8 && p.x <= m.x + NODE_W + 8 && p.y >= m.y - 8 && p.y <= m.y + NODE_H + 8);
			if (target) connect(n.id, target.id, branch);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	// ----- adding / removing -----
	const addNode = (kind: Exclude<FlowNodeKind, "start">) => {
		const el = scroller.current;
		const z = zoomRef.current;
		const { x, y } = freeSpot(draftRef.current.nodes, Math.round(((el?.scrollLeft ?? 0) / z + 60) / 10) * 10, Math.round(((el?.scrollTop ?? 0) / z + 80) / 10) * 10, (el?.clientWidth ?? 800) / z);
		const list = draftRef.current.nodes;
		let i = 1;
		const prefix = kind === "agent" ? "a" : kind === "condition" ? "c" : kind === "subflow" ? "sub" : "end";
		while (list.some((n) => n.id === `${prefix}${i}`)) i++;
		const id = `${prefix}${i}`;
		const count = list.filter((n) => n.kind === kind).length + 1;
		const node: FlowNode =
			kind === "agent"
				? { id, kind, x, y, title: `${t("step")} ${count}`, prompt: "", access: "readonly" }
				: kind === "condition"
					? { id, kind, x, y, title: `${t("kindCondition")} ${count}`, mode: "ai", prompt: "" }
					: kind === "subflow"
						? { id, kind, x, y, title: `${t("kindSubflow")} ${count}`, flowId: "", prompt: "" }
						: { id, kind, x, y, title: t("kindEnd") };
		edit((d) => ({ ...d, nodes: [...d.nodes, node] }));
		setSel({ type: "node", id });
	};
	const removeSel = () => {
		if (!sel) return;
		if (sel.type === "edge") edit((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== sel.id) }));
		else {
			const n = byId.get(sel.id);
			if (!n || n.kind === "start") return;
			edit((d) => ({ ...d, nodes: d.nodes.filter((m) => m.id !== sel.id), edges: d.edges.filter((e) => e.from !== sel.id && e.to !== sel.id) }));
		}
		setSel(null);
	};
	const autoLayout = () => {
		edit((d) => ({ ...d, nodes: layoutFlow(d.nodes, d.edges) }));
		setTimeout(fit, 30);
	};

	// ----- persistence & running -----
	const save = async (): Promise<Flow | undefined> => {
		const cur = draftRef.current;
		if (issues.length) {
			setShowIssues(true);
			const first = issues.find((i) => i.nodeId);
			if (first?.nodeId) {
				setSel({ type: "node", id: first.nodeId });
				reveal(first.nodeId);
			}
			toast(t("issues", { n: issues.length }), "warning");
			return undefined;
		}
		setBusy(true);
		const flow = await pluginCall<Flow>("flows", cur.id ? "update" : "create", { ...cur });
		setBusy(false);
		if (!flow) return undefined;
		setDraft({ ...draftRef.current, id: flow.id });
		setMeta({ updatedAt: flow.updatedAt, nextRunAt: flow.nextRunAt });
		setDirty(false);
		toast(t("saved"));
		onSaved(flow);
		return flow;
	};
	const defaultWhere = useDefaultLocation();
	const startRun = async (input: string, where: string) => {
		setDialog(null);
		const flow = dirty || !draftRef.current.id ? await save() : ({ id: draftRef.current.id } as Flow);
		if (!flow) return;
		await pluginCall("flows", "run", { id: flow.id, input, workspaceId: where });
	};
	const leave = async () => {
		if (dirty && !(await confirmDialog(t("confirmLeave")))) return;
		onClose();
	};
	const aiToken = useRef(0);
	const aiEdit = async (description: string) => {
		const token = ++aiToken.current;
		setBusy(true);
		const cur = draftRef.current;
		const prompt = `${description}\n\n当前流程（请在此基础上修改后输出完整 JSON，保持节点 id 不变）：\n${JSON.stringify({ name: cur.name, description: cur.description, nodes: cur.nodes, edges: cur.edges })}`;
		const next = await pluginCall<FlowInput>("flows", "generate", { description: prompt, workspaceId: cur.workspaceId });
		if (token !== aiToken.current) return; // cancelled meanwhile
		setBusy(false);
		if (!next) return;
		setDialog(null);
		edit((d) => ({ ...d, name: d.name || next.name, description: d.description || next.description, nodes: next.nodes, edges: next.edges }));
		setSel(null);
		setTimeout(fit, 30);
		toast(t("replaced"));
	};

	// ----- keyboard -----
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const tag = (e.target as HTMLElement).tagName;
			const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
			const mod = e.ctrlKey || e.metaKey;
			if (mod && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void save();
			} else if (!typing && mod && e.key.toLowerCase() === "z") {
				e.preventDefault();
				e.shiftKey ? redo() : undo();
			} else if (!typing && mod && e.key.toLowerCase() === "y") {
				e.preventDefault();
				redo();
			} else if (!typing && (e.key === "Delete" || (e.key === "Backspace" && tag === "BODY"))) removeSel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	// ----- derived view data -----
	const selNode = sel?.type === "node" ? byId.get(sel.id) : undefined;
	const statusText = (s: string) => t(s === "success" ? "success" : s === "error" ? "failed" : (s as "running" | "skipped" | "pending"));
	const prog = paint ? runProgress(nodes, paint) : { done: 0, total: 0, current: [] as string[] };
	const doneCount = prog.done;
	const currentNames = prog.current;
	const workTotal = prog.total;
	const sessionCount = paint ? Object.values(paint.nodes).filter((n) => n.sessionId).length : 0;
	const runMs = paint ? (paint.finishedAt ? new Date(paint.finishedAt).getTime() : now) - new Date(paint.startedAt).getTime() : 0;
	const lastSession = paint ? Object.values(paint.nodes).filter((n) => n.sessionId).at(-1)?.sessionId : undefined;
	const hasSchedule = draft.scheduleEnabled === true && !!draft.schedule;
	const panel = selNode || sel?.type === "edge" || paint?.output;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex flex-wrap items-center gap-2 border-b hairline px-4 py-2.5 pr-14">
				<Button variant="ghost" onClick={() => void leave()} aria-label={t("back")}>
					<ArrowLeft className="size-4" />
				</Button>
				<div className="w-48 max-sm:w-full">
					<Input value={draft.name} onChange={(e) => edit((d) => ({ ...d, name: e.target.value }), "name")} placeholder={t("name")} maxLength={80} />
				</div>
				<div className="min-w-40 flex-1">
					<Input value={draft.description} onChange={(e) => edit((d) => ({ ...d, description: e.target.value }), "desc")} placeholder={t("desc")} maxLength={500} />
				</div>
				<div className="w-32 max-sm:w-full">
					<Select value={draft.workspaceId} onChange={(e) => edit((d) => ({ ...d, workspaceId: e.target.value }))} aria-label={t("workspace")} title={t("bindHint")}>
						<option value="">{t("general")}</option>
						{workspaces.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name}
							</option>
						))}
					</Select>
				</div>
				<div className="flex flex-wrap items-center gap-1.5 @max-5xl:ml-auto">
					{dirty && <span className="mr-1 text-xs text-ember-300">● {t("unsaved")}</span>}
					<Button variant="ghost" onClick={undo} disabled={!history.current.past.length} title={t("undo")} aria-label={t("undo")}>
						<Undo2 className="size-4" />
					</Button>
					<Button variant="ghost" onClick={redo} disabled={!history.current.future.length} title={t("redo")} aria-label={t("redo")}>
						<Redo2 className="size-4" />
					</Button>
					<Button variant={hasSchedule ? "primary" : "outline"} onClick={() => setDialog("schedule")} title={hasSchedule ? describeSchedule(draft.schedule, lang) : t("schedule")}>
						<AlarmClock className="size-4" /> <span className={hasSchedule ? "" : "@max-3xl:hidden"}>{hasSchedule ? describeSchedule(draft.schedule, lang) : t("schedule")}</span>
					</Button>
					<Button variant="outline" onClick={() => setDialog("ai")} disabled={busy} title={t("aiEdit")}>
						<Sparkles className="size-4" /> <span className="@max-3xl:hidden">{t("aiEdit")}</span>
					</Button>
					<Button variant="outline" onClick={() => void save()} disabled={busy || !dirty} title={t("save")}>
						<Save className="size-4" /> <span className="@max-3xl:hidden">{t("save")}</span>
					</Button>
					{running ? (
						<Button variant="danger" onClick={() => void pluginCall("flows", "cancel", { runId: run!.id })}>
							<CircleStop className="size-4" /> {t("stop")}
						</Button>
					) : (
						<Button variant="primary" onClick={() => setDialog("run")} disabled={busy}>
							<Play className="size-4" /> {t("run")}
						</Button>
					)}
				</div>
			</header>

			{paint && (
				<div className={clsx("flex flex-wrap items-center gap-x-3 gap-y-1 border-b hairline px-4 py-2 text-xs", running ? "bg-ember-500/5" : paint.status === "success" ? "bg-moss-400/5" : paint.status === "error" ? "bg-rose-400/5" : "")}>
					{running ? <LoaderCircle className="size-3.5 animate-spin text-ember-300" /> : paint.status === "success" ? <Badge tone="moss">{t("runDone")}</Badge> : paint.status === "error" ? <Badge tone="rose">{t("runFailed")}</Badge> : <Badge>{t("runCancelled")}</Badge>}
					<span className="text-ink-300">{t("stepOf", { done: doneCount, total: workTotal })}</span>
					<div className="h-1.5 w-40 overflow-hidden rounded-full bg-ink-800">
						<div className={clsx("h-full rounded-full transition-all duration-500", paint.status === "error" ? "bg-rose-400" : paint.status === "success" ? "bg-moss-400" : "bg-ember-400")} style={{ width: `${workTotal ? (doneCount / workTotal) * 100 : 0}%` }} />
					</div>
					{running && currentNames.length > 0 && <span className="text-ember-200">{t("current", { name: currentNames.join("、") })}</span>}
					<span className="text-ink-500">{t("took", { t: fmtDur(runMs) })}</span>
					{paint.location && <span className="text-ink-400">· {t("ranIn", { place: placeLabel(lang === "zh" ? "zh" : "en", paint.location) })}</span>}
					{paint.trigger === "schedule" && <span className="text-ink-500">· {t("viaSchedule")}</span>}
					{paint.trigger === "agent" && <span className="text-ink-500">· {t("viaAgent")}</span>}
					{paint.error && <span className="min-w-0 flex-1 truncate text-rose-400">{paint.error}</span>}
					{lastSession && (
						<button type="button" className="ml-auto flex items-center gap-1 text-ember-300 hover:underline" onClick={() => void openSession(lastSession)}>
							<MessageSquare className="size-3" /> {t("sessions")} ({sessionCount})
						</button>
					)}
				</div>
			)}

				<div className="flex flex-wrap items-center gap-2 border-b hairline bg-ink-900/60 px-3 py-1.5">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="px-1 text-[11px] text-ink-500">{t("palette")}</span>
						<Button variant="outline" onClick={() => addNode("agent")}>
							<Bot className="size-3.5" /> {t("addAgent")}
						</Button>
						<Button variant="outline" onClick={() => addNode("condition")}>
							<GitBranch className="size-3.5" /> {t("addCondition")}
						</Button>
						<Button variant="outline" onClick={() => addNode("subflow")} disabled={flows.filter((f) => f.id !== draft.id).length === 0} title={flows.filter((f) => f.id !== draft.id).length === 0 ? t("subflowNone") : undefined}>
							<Workflow className="size-3.5" /> {t("addSubflow")}
						</Button>
						<Button variant="outline" onClick={() => addNode("end")}>
							<Flag className="size-3.5" /> {t("addEnd")}
						</Button>
						<Button variant="ghost" onClick={autoLayout}>
							<LayoutGrid className="size-3.5" /> {t("layout")}
						</Button>
					</div>
					<div className="ml-auto flex items-center gap-0.5">
						<Button variant="ghost" onClick={() => setZoom(zoomRef.current / 1.2)} aria-label={t("zoomOut")} title={t("zoomOut")}>
							<Minus className="size-3.5" />
						</Button>
						<button type="button" className="w-12 text-center text-xs tabular-nums text-ink-300 hover:text-ink-100" onClick={() => setZoom(1)} title="100%">
							{Math.round(zoom * 100)}%
						</button>
						<Button variant="ghost" onClick={() => setZoom(zoomRef.current * 1.2)} aria-label={t("zoomIn")} title={t("zoomIn")}>
							<Plus className="size-3.5" />
						</Button>
						<Button variant="ghost" onClick={fit} aria-label={t("fit")} title={t("fit")}>
							<Maximize className="size-3.5" />
						</Button>
					</div>
				</div>

			<div className="relative min-h-0 flex-1 bg-ink-950/50">
				<div ref={scroller} className="absolute inset-0 overflow-auto" onPointerDown={panStart}>
					<div style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom }} data-bg="1">
						<div
							ref={canvas}
							data-bg="1"
							className="relative origin-top-left"
							style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom})`, backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
						>
							<svg className="pointer-events-none absolute inset-0" width={CANVAS_W} height={CANVAS_H}>
								<defs>
									<marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
										<path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
									</marker>
								</defs>
								{draft.edges.map((e) => {
									const a = byId.get(e.from);
									const b = byId.get(e.to);
									if (!a || !b) return null;
									const p = outPoint(a, e.branch);
									const q = { x: b.x - 9, y: b.y + NODE_H / 2 };
									const on = sel?.type === "edge" && sel.id === e.id;
									const sa = nodeRun(e.from)?.status;
									const sb = nodeRun(e.to)?.status;
									const flowing = sa === "success" && sb === "running";
									const passed = sa === "success" && (sb === "success" || sb === "running" || sb === "error");
									const dead = paint && (sb === "skipped" || sa === "skipped");
									const bad = showIssues && issueEdges.has(e.id);
									const d = curve(p, q);
									return (
										<g key={e.id} className={clsx(bad ? "text-rose-400" : on ? "text-ember-300" : flowing ? "text-ember-400" : passed ? "text-moss-400" : "text-ink-500", dead && "opacity-30")}>
											<path d={d} fill="none" stroke="currentColor" strokeWidth={on ? 2.8 : 2} markerEnd="url(#flow-arrow)" className={flowing ? "flow-edge-live" : undefined} strokeDasharray={flowing ? "8 6" : undefined} />
											<path d={d} fill="none" stroke="transparent" strokeWidth={16} className="pointer-events-auto cursor-pointer" onPointerDown={(ev) => (ev.stopPropagation(), setSel({ type: "edge", id: e.id }))} />
											{e.branch && (
												<text x={p.x + 12} y={p.y + (e.branch === "true" ? -7 : 15)} fontSize={12} fontWeight={600} fill={e.branch === "true" ? "#9bc77a" : "#f0767a"} className="select-none">
													{e.branch === "true" ? t("yes") : t("no")}
												</text>
											)}
										</g>
									);
								})}
								{link && <path d={curve(outPoint(byId.get(link.from)!, link.branch), { x: link.x, y: link.y })} fill="none" stroke="#ffa055" strokeWidth={2} strokeDasharray="5 4" />}
							</svg>

							{nodes.map((n) => {
								const Icon = KIND_ICON[n.kind];
								const nr = nodeRun(n.id);
								const st = nr?.status;
								const picked = sel?.type === "node" && sel.id === n.id;
								const problems = issueNodes.get(n.id);
								const dur = nr?.startedAt ? (nr.finishedAt ? new Date(nr.finishedAt).getTime() : now) - new Date(nr.startedAt).getTime() : 0;
								const preview = st === "success" && nr?.output && n.kind === "agent" ? nr.output.replace(/\s+/g, " ") : n.prompt || n.match || "…";
								return (
									<div
										key={n.id}
										onPointerDown={(e) => dragNode(e, n)}
										className={clsx(
											"absolute cursor-grab touch-none rounded-xl border bg-ink-900 px-3 py-2 shadow-lg shadow-black/30 transition-[border-color,box-shadow,opacity] select-none active:cursor-grabbing",
											st && st !== "pending" ? STATUS_RING[st] : showIssues && problems ? "border-rose-400 shadow-[0_0_0_3px_rgba(240,118,122,0.18)]" : n.kind === "subflow" ? "border-dashed border-ink-500" : "border-ink-700",
											picked && "ring-2 ring-ember-400/70",
										)}
										style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
									>
										<div className="flex items-center gap-1.5 text-[11px] text-ink-400">
											<Icon className={clsx("size-3.5", n.kind === "agent" ? "text-ember-300" : n.kind === "condition" ? "text-sky-400" : n.kind === "subflow" ? "text-ember-200" : n.kind === "start" ? "text-moss-400" : "text-ink-300")} />
											{t(n.kind === "start" ? "kindStart" : n.kind === "agent" ? "kindAgent" : n.kind === "condition" ? "kindCondition" : n.kind === "subflow" ? "kindSubflow" : "kindEnd")}
											<span className="ml-auto flex items-center gap-1">
												{st === "running" && <LoaderCircle className="size-3.5 animate-spin text-ember-300" />}
												{st && st !== "pending" && st !== "running" && <span className={clsx(st === "success" && "text-moss-400", st === "error" && "text-rose-400")}>{statusText(st)}</span>}
												{dur > 0 && st !== "skipped" && <span className="tabular-nums text-ink-500">{fmtDur(dur)}</span>}
											</span>
										</div>
										<div className="mt-1 truncate text-sm font-medium text-ink-100">{n.title}</div>
										{(n.kind === "agent" || n.kind === "condition") && <div className="truncate text-[11px] text-ink-500">{preview}</div>}
										{n.kind === "subflow" && <div className="truncate text-[11px] text-ink-500">{childLine(n, nr)}</div>}
										{problems && !st && (
											<span title={problems.join("\n")} className="absolute -top-2 -right-2 grid size-5 place-items-center rounded-full bg-ember-500 text-[11px] font-bold text-white">
												!
											</span>
										)}
										{n.kind !== "start" && <span data-handle className="absolute top-1/2 -left-1.5 size-3 -translate-y-1/2 rounded-full border border-ink-500 bg-ink-800" />}
										{n.kind !== "end" &&
											(n.kind === "condition" ? (
												<>
													<Handle top="26%" label={t("yes")} tone="moss" onDown={(e) => startLink(e, n, "true")} />
													<Handle top="74%" label={t("no")} tone="rose" onDown={(e) => startLink(e, n, "false")} />
												</>
											) : (
												<Handle top="50%" onDown={(e) => startLink(e, n)} />
											))}
									</div>
								);
							})}
						</div>
					</div>
				</div>

				<p className="pointer-events-none absolute bottom-2 left-3 hidden text-[11px] text-ink-600 lg:block">{t("dragHint")}</p>

				{showIssues && issues.length > 0 && (
					<div className="absolute bottom-3 left-3 z-10 max-h-48 w-[min(26rem,calc(100%-1.5rem))] overflow-auto rounded-xl border border-rose-400/50 bg-ink-900/95 p-2 shadow-xl backdrop-blur max-md:hidden">
						<div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-rose-400">
							<CircleAlert className="size-3.5" /> {t("issues", { n: issues.length })}
						</div>
						<ul>
							{issues.map((i, k) => (
								<li key={k}>
									<button
										type="button"
										disabled={!i.nodeId && !i.edgeId}
										onClick={() => {
											if (i.nodeId) {
												setSel({ type: "node", id: i.nodeId });
												reveal(i.nodeId);
											} else if (i.edgeId) {
												setSel({ type: "edge", id: i.edgeId });
												const e = draft.edges.find((x) => x.id === i.edgeId);
												if (e) reveal(e.from);
											}
										}}
										className="w-full rounded-lg px-2 py-1 text-left text-xs text-ink-300 enabled:hover:bg-ink-800"
										title={i.nodeId || i.edgeId ? t("issueGo") : undefined}
									>
										{i.message}
									</button>
								</li>
							))}
						</ul>
					</div>
				)}

				{panel && (
					<aside className="absolute z-10 overflow-y-auto rounded-xl border border-ink-700 bg-ink-900/95 p-4 shadow-2xl backdrop-blur max-md:inset-x-2 max-md:bottom-2 max-md:max-h-[55%] md:top-3 md:right-3 md:bottom-3 md:w-72">
						<div className="mb-3 flex items-center justify-between">
							<h3 className="text-xs font-medium tracking-wide text-ink-300">{t("inspector")}</h3>
							<button type="button" aria-label={t("cancel")} onClick={() => setSel(null)} className="rounded-md p-0.5 text-ink-500 hover:bg-ink-800 hover:text-ink-100">
								<X className="size-3.5" />
							</button>
						</div>
						{!selNode ? (
							sel?.type === "edge" ? (
								<Button variant="danger" onClick={removeSel}>
									<Trash2 className="size-4" /> {t("deleteEdge")}
								</Button>
							) : (
								<p className="text-sm text-ink-500">{t("pick")}</p>
							)
						) : (
							<div className="space-y-3">
								<Field label={t("title")}>
									<Input value={selNode.title} onChange={(e) => patchNode(selNode.id, { title: e.target.value }, "title")} maxLength={60} />
								</Field>
								{selNode.kind === "agent" && (
									<>
										<Field label={t("prompt")}>
											<Textarea rows={7} value={selNode.prompt ?? ""} onChange={(e) => patchNode(selNode.id, { prompt: e.target.value }, "prompt")} placeholder={t("promptPh")} />
										</Field>
										<Field label={t("access")}>
											<Select value={selNode.access ?? "readonly"} onChange={(e) => patchNode(selNode.id, { access: e.target.value as RunAccess })}>
												<option value="readonly">{t("readonly")}</option>
												<option value="edits">{t("edits")}</option>
												<option value="full">{t("full")}</option>
											</Select>
										</Field>
										<Field label={t("model")}>
											<Select
												value={selNode.model ? `${selNode.model.provider}/${selNode.model.id}` : ""}
												onChange={(e) => {
													const m = models.find((x) => `${x.provider}/${x.id}` === e.target.value);
													patchNode(selNode.id, { model: m ? { provider: m.provider, id: m.id } : undefined });
												}}
											>
												<option value="">{t("modelDefault")}</option>
												{models.map((m) => (
													<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
														{m.provider} / {m.name}
													</option>
												))}
											</Select>
										</Field>
									</>
								)}
								{selNode.kind === "condition" && (
									<>
										<Field label={t("condMode")}>
											<Select value={selNode.mode ?? "ai"} onChange={(e) => patchNode(selNode.id, { mode: e.target.value as FlowNode["mode"] })}>
												<option value="ai">{t("condAi")}</option>
												<option value="contains">{t("condContains")}</option>
												<option value="regex">{t("condRegex")}</option>
											</Select>
										</Field>
										{(selNode.mode ?? "ai") === "ai" ? (
											<Field label={t("question")}>
												<Textarea rows={3} value={selNode.prompt ?? ""} onChange={(e) => patchNode(selNode.id, { prompt: e.target.value }, "prompt")} placeholder={t("questionPh")} />
											</Field>
										) : (
											<Field label={t("match")}>
												<Input value={selNode.match ?? ""} onChange={(e) => patchNode(selNode.id, { match: e.target.value }, "match")} />
											</Field>
										)}
									</>
								)}
								{selNode.kind === "subflow" && (
									<>
										<Field label={t("subflowPick")}>
											<Select
												value={selNode.flowId ?? ""}
												onChange={(e) => {
													const f = flows.find((x) => x.id === e.target.value);
													const generic = /^(子流程|Subflow)( \d+)?$/.test(selNode.title);
													patchNode(selNode.id, { flowId: e.target.value, ...(f && generic ? { title: f.name.slice(0, 60) } : {}) });
												}}
											>
												<option value="">{t("subflowNone")}</option>
												{flows
													.filter((f) => f.id !== draft.id)
													.map((f) => (
														<option key={f.id} value={f.id}>
															{f.name}
														</option>
													))}
											</Select>
										</Field>
										<Field label={t("subflowInput")}>
											<Textarea rows={3} value={selNode.prompt ?? ""} onChange={(e) => patchNode(selNode.id, { prompt: e.target.value }, "prompt")} placeholder={t("subflowInputPh")} />
										</Field>
										<p className="text-[11px] text-ink-500">{t("subflowOutput")}</p>
										{flows.find((f) => f.id === selNode.flowId) && (
											<Button variant="outline" onClick={() => void openSub(flows.find((f) => f.id === selNode.flowId)!)}>
												<Workflow className="size-4" /> {t("subflowOpen")}
											</Button>
										)}
										{(() => {
											const f = flows.find((x) => x.id === selNode.flowId);
											const child = nodeRun(selNode.id)?.childRunId ? runs.find((r) => r.id === nodeRun(selNode.id)!.childRunId) : undefined;
											if (!f || !child) return null;
											return (
												<div className="space-y-1 rounded-lg border border-ink-700 p-2.5">
													<span className="text-xs font-medium text-ink-300">{t("subflowSteps")}</span>
													<ul className="space-y-0.5">
														{f.nodes
															.filter((n) => n.kind === "agent" || n.kind === "condition" || n.kind === "subflow")
															.map((n) => (
																<li key={n.id} className="flex items-center gap-2 text-xs text-ink-400">
																	<span className="min-w-0 flex-1 truncate">{n.title}</span>
																	<span className={clsx(child.nodes[n.id]?.status === "success" && "text-moss-400", child.nodes[n.id]?.status === "error" && "text-rose-400", child.nodes[n.id]?.status === "running" && "text-ember-300")}>
																		{statusText(child.nodes[n.id]?.status ?? "pending")}
																	</span>
																</li>
															))}
													</ul>
												</div>
											);
										})()}
									</>
								)}
								{showIssues && issueNodes.get(selNode.id)?.map((m, k) => (
									<p key={k} className="flex gap-1.5 text-xs text-rose-400">
										<CircleAlert className="mt-0.5 size-3 shrink-0" /> {m}
									</p>
								))}
								<p className="text-[11px] text-ink-500">{t("nodeId", { id: selNode.id, ref: `{{${selNode.id}}}` })}</p>
								{nodeRun(selNode.id) && nodeRun(selNode.id)!.status !== "pending" && (
									<div className="space-y-1.5 rounded-lg border border-ink-700 p-2.5">
										<div className="flex items-center gap-2">
											<span className="text-xs font-medium text-ink-300">{t("output")}</span>
											<Badge tone={nodeRun(selNode.id)!.status === "success" ? "moss" : nodeRun(selNode.id)!.status === "error" ? "rose" : "muted"}>{statusText(nodeRun(selNode.id)!.status)}</Badge>
											{nodeRun(selNode.id)!.sessionId && (
												<button type="button" className="ml-auto flex items-center gap-1 text-xs text-ember-300 hover:underline" onClick={() => void openSession(nodeRun(selNode.id)!.sessionId!)}>
													<MessageSquare className="size-3" /> {t("openChat")}
												</button>
											)}
										</div>
										{nodeRun(selNode.id)!.error && <p className="text-xs text-rose-400">{nodeRun(selNode.id)!.error}</p>}
										{nodeRun(selNode.id)!.output && <pre className="max-h-48 overflow-auto text-xs whitespace-pre-wrap text-ink-300">{nodeRun(selNode.id)!.output}</pre>}
									</div>
								)}
								{selNode.kind !== "start" && (
									<Button variant="danger" onClick={removeSel}>
										<Trash2 className="size-4" /> {t("deleteNode")}
									</Button>
								)}
							</div>
						)}
						{paint?.output && (
							<div className="mt-4 space-y-1.5 rounded-lg border border-ink-700 p-2.5">
								<span className="text-xs font-medium text-ink-300">{t("runResult")}</span>
								<pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap text-ink-300">{paint.output}</pre>
							</div>
						)}
					</aside>
				)}
			</div>

			{dialog === "run" && <RunDialog flow={draft} defaultWhere={defaultWhere} onClose={() => setDialog(null)} onStart={(input, where) => void startRun(input, where)} />}
			{dialog === "ai" && (
				<AiDialog
					busy={busy}
					onClose={() => {
						aiToken.current++;
						setBusy(false);
						setDialog(null);
					}}
					onSubmit={(d) => void aiEdit(d)}
				/>
			)}
			{dialog === "schedule" && (
				<ScheduleDialog
					flow={draft}
					lang={lang}
					value={{ schedule: draft.schedule, scheduleEnabled: draft.scheduleEnabled, scheduleInput: draft.scheduleInput, scheduleWorkspaceId: draft.scheduleWorkspaceId }}
					nextRunAt={meta.nextRunAt}
					onClose={() => setDialog(null)}
					onApply={(v) => {
						setDialog(null);
						edit((d) => {
							const { schedule: _s, scheduleEnabled: _e, scheduleInput: _i, scheduleWorkspaceId: _w, ...rest } = d;
							const where = { scheduleWorkspaceId: v.scheduleWorkspaceId ?? "" };
							return v.scheduleEnabled ? { ...rest, ...where, schedule: v.schedule, scheduleEnabled: true, scheduleInput: v.scheduleInput ?? "" } : { ...rest, ...(v.schedule ? { ...where, schedule: v.schedule, scheduleEnabled: false, scheduleInput: v.scheduleInput ?? "" } : {}) };
						});
					}}
				/>
			)}
		</div>
	);
}

function Handle({ top, label, tone, onDown }: { top: string; label?: string; tone?: "moss" | "rose"; onDown: (e: ReactPointerEvent) => void }) {
	return (
		<span
			data-handle
			onPointerDown={onDown}
			title={label}
			className={clsx(
				"absolute -right-2 size-4 -translate-y-1/2 cursor-crosshair rounded-full border-2 bg-ink-800 transition-transform hover:scale-125",
				tone === "moss" ? "border-moss-400" : tone === "rose" ? "border-rose-400" : "border-ember-400",
			)}
			style={{ top }}
		/>
	);
}

function RunDialog({ flow, defaultWhere, onClose, onStart }: { flow: Draft; defaultWhere: string; onClose: () => void; onStart: (input: string, where: string) => void }) {
	const t = useT(M);
	const [input, setInput] = useState("");
	const [where, setWhere] = useState(defaultWhere);
	return (
		<Dialog title={t("runInput")} onClose={onClose}>
			<div className="space-y-3">
				<Field label={t("runInput")} hint={t("runInputHint")}>
					<Textarea rows={5} value={input} onChange={(e) => setInput(e.target.value)} autoFocus />
				</Field>
				<LocationField flow={flow} value={where} onChange={setWhere} />
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button variant="primary" onClick={() => onStart(input, where)}>
						<Play className="size-4" /> {t("start")}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}

function AiDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (description: string) => void }) {
	const t = useT(M);
	const [text, setText] = useState("");
	return (
		<Dialog title={t("aiEditTitle")} onClose={onClose}>
			<div className="space-y-3">
				<Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("aiEditPh")} autoFocus disabled={busy} />
				<div className="flex items-center justify-end gap-2">
					{busy && (
						<span className="mr-auto flex items-center gap-1.5 text-xs text-ink-400">
							<LoaderCircle className="size-3.5 animate-spin" /> {t("generating")}
						</span>
					)}
					<Button variant="ghost" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button variant="primary" onClick={() => text.trim() && onSubmit(text)} disabled={busy || !text.trim()}>
						<Sparkles className="size-4" /> {t("generate")}
					</Button>
				</div>
			</div>
		</Dialog>
	);
}
