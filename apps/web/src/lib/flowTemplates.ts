import type { FlowEdge, FlowInput, FlowNode } from "@prometheus/protocol";
import { layoutFlow } from "./flowLayout.ts";

export interface FlowTemplate {
	id: string;
	icon: "review" | "release" | "spec" | "bug" | "report";
	name: { zh: string; en: string };
	desc: { zh: string; en: string };
	build(lang: "zh" | "en"): Pick<FlowInput, "name" | "description" | "nodes" | "edges">;
}

type Spec = { id: string; kind: FlowNode["kind"]; zh: string; en: string; pz?: string; pe?: string; access?: FlowNode["access"]; mode?: FlowNode["mode"]; match?: string };

function make(name: FlowTemplate["name"], desc: FlowTemplate["desc"], specs: Spec[], links: [string, string, ("true" | "false")?][]): FlowTemplate["build"] {
	return (lang) => {
		const nodes: FlowNode[] = specs.map((s) => ({
			id: s.id,
			kind: s.kind,
			x: 0,
			y: 0,
			title: lang === "zh" ? s.zh : s.en,
			...(s.kind === "agent" || s.kind === "condition" ? { prompt: lang === "zh" ? s.pz : s.pe } : {}),
			...(s.kind === "agent" ? { access: s.access ?? "readonly" } : {}),
			...(s.kind === "condition" ? { mode: s.mode ?? "ai", ...(s.match ? { match: s.match } : {}) } : {}),
		}));
		const edges: FlowEdge[] = links.map(([from, to, branch], i) => ({ id: `e${i + 1}`, from, to, ...(branch ? { branch } : {}) }));
		return { name: name[lang], description: desc[lang], nodes: layoutFlow(nodes, edges), edges };
	};
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
	{
		id: "review",
		icon: "review",
		name: { zh: "代码评审 SOP", en: "Code review SOP" },
		desc: { zh: "读改动 → 并行查安全与性能 → 汇总评审意见", en: "Read the diff → check security and performance in parallel → merged review" },
		build: make(
			{ zh: "代码评审 SOP", en: "Code review SOP" },
			{ zh: "输入要评审的范围（如最近一次提交），输出结构化评审意见", en: "Input what to review (e.g. the last commit); outputs a structured review" },
			[
				{ id: "start", kind: "start", zh: "开始", en: "Start" },
				{ id: "diff", kind: "agent", zh: "梳理改动", en: "Read the changes", pz: "评审范围：{{input}}\n用 git 查看对应改动，概括改了什么、涉及哪些模块，列出需要重点检查的文件。", pe: "Review scope: {{input}}\nUse git to look at the changes, summarise what changed and which modules are touched, and list the files that need attention." },
				{ id: "sec", kind: "agent", zh: "安全检查", en: "Security check", pz: "根据下面的改动梳理，检查安全问题（注入、越权、密钥泄露、不安全的依赖），给出具体文件和行。\n\n{{diff}}", pe: "From the change summary below, look for security problems (injection, privilege escalation, leaked secrets, unsafe dependencies) and cite files and lines.\n\n{{diff}}" },
				{ id: "perf", kind: "agent", zh: "性能与正确性", en: "Performance & correctness", pz: "根据下面的改动梳理，检查性能退化、边界条件和逻辑错误，给出具体文件和行。\n\n{{diff}}", pe: "From the change summary below, look for performance regressions, edge cases and logic errors, citing files and lines.\n\n{{diff}}" },
				{ id: "sum", kind: "agent", zh: "汇总评审意见", en: "Merge the review", pz: "把安全检查和性能检查的结果合并成一份评审意见：先给结论（可合并/需修改），再按严重程度列出问题。\n\n安全：{{sec}}\n\n性能与正确性：{{perf}}", pe: "Merge the security and performance findings into one review: a verdict first (OK to merge / needs changes), then the issues by severity.\n\nSecurity: {{sec}}\n\nPerformance & correctness: {{perf}}" },
				{ id: "end", kind: "end", zh: "结束", en: "End" },
			],
			[["start", "diff"], ["diff", "sec"], ["diff", "perf"], ["sec", "sum"], ["perf", "sum"], ["sum", "end"]],
		),
	},
	{
		id: "bug",
		icon: "bug",
		name: { zh: "缺陷排查与修复", en: "Bug triage & fix" },
		desc: { zh: "复现并定位 → 判断是否找到根因 → 修复或给出调查报告", en: "Reproduce and locate → root cause found? → fix, or write up the investigation" },
		build: make(
			{ zh: "缺陷排查与修复", en: "Bug triage & fix" },
			{ zh: "输入缺陷描述；找到根因就修复，否则输出调查报告", en: "Input a bug report; fixes it if the root cause is found, otherwise reports what was learned" },
			[
				{ id: "start", kind: "start", zh: "开始", en: "Start" },
				{ id: "locate", kind: "agent", zh: "复现并定位", en: "Reproduce & locate", pz: "缺陷描述：{{input}}\n尝试复现并定位根因。明确写出：根因是什么、在哪个文件、证据是什么；找不到就写明已排除了什么。", pe: "Bug report: {{input}}\nTry to reproduce and locate the root cause. State what it is, in which file, and the evidence; if you cannot find it, say what you ruled out." },
				{ id: "found", kind: "condition", zh: "找到根因了？", en: "Root cause found?", mode: "ai", pz: "上面的调查是否已经明确找到了根因（有具体文件和证据）？", pe: "Does the investigation above clearly identify the root cause (a specific file and evidence)?" },
				{ id: "fix", kind: "agent", zh: "修复并验证", en: "Fix & verify", access: "full", pz: "根据下面的根因做最小修复，并运行相关测试验证，最后说明改了什么。\n\n{{locate}}", pe: "Make the smallest fix for the root cause below and run the related tests, then say what you changed.\n\n{{locate}}" },
				{ id: "report", kind: "agent", zh: "调查报告", en: "Investigation report", pz: "整理一份调查报告：已验证的事实、已排除的原因、建议下一步怎么查。\n\n{{locate}}", pe: "Write an investigation report: verified facts, ruled-out causes and suggested next steps.\n\n{{locate}}" },
				{ id: "end", kind: "end", zh: "结束", en: "End" },
			],
			[["start", "locate"], ["locate", "found"], ["found", "fix", "true"], ["found", "report", "false"], ["fix", "end"], ["report", "end"]],
		),
	},
	{
		id: "spec",
		icon: "spec",
		name: { zh: "需求 → 方案 + 用例", en: "Request → design + tests" },
		desc: { zh: "梳理影响范围 → 并行写方案与测试用例 → 合成评审文档", en: "Find what is affected → write design and test cases in parallel → one review document" },
		build: make(
			{ zh: "需求 → 方案 + 用例", en: "Request → design + tests" },
			{ zh: "输入一个需求，输出可直接评审的方案文档", en: "Input a feature request; outputs a design document ready for review" },
			[
				{ id: "start", kind: "start", zh: "开始", en: "Start" },
				{ id: "scope", kind: "agent", zh: "梳理影响范围", en: "Find what is affected", pz: "需求：{{input}}\n阅读代码，列出会受影响的模块、文件和接口，以及主要风险。", pe: "Request: {{input}}\nRead the code and list the modules, files and interfaces that will be affected, plus the main risks." },
				{ id: "design", kind: "agent", zh: "写实现方案", en: "Write the design", pz: "基于下面的影响范围写实现方案：改动点、步骤、兼容性与回滚。\n\n{{scope}}", pe: "Based on the scope below, write the design: changes, steps, compatibility and rollback.\n\n{{scope}}" },
				{ id: "tests", kind: "agent", zh: "写测试用例", en: "Write test cases", pz: "基于下面的影响范围写测试用例清单：正常、边界、异常，每条写明预期。\n\n{{scope}}", pe: "Based on the scope below, write a test case list: normal, edge and failure cases, each with the expected result.\n\n{{scope}}" },
				{ id: "doc", kind: "agent", zh: "合成评审文档", en: "Compose the review doc", pz: "把方案和测试用例合成一份评审文档（Markdown），开头用三行说明需求、方案要点和主要风险。\n\n方案：{{design}}\n\n用例：{{tests}}", pe: "Combine the design and test cases into one review document (Markdown), opening with three lines on the request, key points and main risks.\n\nDesign: {{design}}\n\nTests: {{tests}}" },
				{ id: "end", kind: "end", zh: "结束", en: "End" },
			],
			[["start", "scope"], ["scope", "design"], ["scope", "tests"], ["design", "doc"], ["tests", "doc"], ["doc", "end"]],
		),
	},
	{
		id: "release",
		icon: "release",
		name: { zh: "发布前检查", en: "Pre-release check" },
		desc: { zh: "构建与测试 → 通过则整理发布说明，失败则汇总原因", en: "Build and test → release notes if green, failure summary if not" },
		build: make(
			{ zh: "发布前检查", en: "Pre-release check" },
			{ zh: "每次发布前运行，通过则产出发布说明", en: "Run before every release; produces release notes when everything passes" },
			[
				{ id: "start", kind: "start", zh: "开始", en: "Start" },
				{ id: "check", kind: "agent", zh: "构建与测试", en: "Build & test", access: "full", pz: "运行项目的构建和测试命令，最后只用一句话说明结果，并以 PASS 或 FAIL 开头，附上失败的用例。", pe: "Run the project's build and test commands. Finish with a one-line result that starts with PASS or FAIL, listing any failing tests." },
				{ id: "ok", kind: "condition", zh: "全部通过？", en: "All green?", mode: "contains", match: "PASS" },
				{ id: "notes", kind: "agent", zh: "整理发布说明", en: "Write release notes", pz: "根据自上个版本以来的提交整理发布说明，按「新增 / 修复 / 变更」分类。", pe: "From the commits since the last release, write release notes grouped as Added / Fixed / Changed." },
				{ id: "fail", kind: "agent", zh: "汇总失败原因", en: "Summarise failures", pz: "分析下面的失败原因，给出最可能的原因和修复建议。\n\n{{check}}", pe: "Analyse the failures below and give the most likely causes and fix suggestions.\n\n{{check}}" },
				{ id: "end", kind: "end", zh: "结束", en: "End" },
			],
			[["start", "check"], ["check", "ok"], ["ok", "notes", "true"], ["ok", "fail", "false"], ["notes", "end"], ["fail", "end"]],
		),
	},
	{
		id: "report",
		icon: "report",
		name: { zh: "每日工作简报", en: "Daily brief" },
		desc: { zh: "汇总昨日提交与待办 → 生成一页简报（适合配合定时）", en: "Collect yesterday's commits and TODOs → one-page brief (pairs well with a schedule)" },
		build: make(
			{ zh: "每日工作简报", en: "Daily brief" },
			{ zh: "配上每天定时，早上就能看到项目简报", en: "Put it on a daily schedule to get a project brief every morning" },
			[
				{ id: "start", kind: "start", zh: "开始", en: "Start" },
				{ id: "commits", kind: "agent", zh: "昨日提交", en: "Yesterday's commits", pz: "用 git 总结最近一天的提交：谁改了什么、是否有风险。", pe: "Use git to summarise the last day's commits: who changed what, and whether anything is risky." },
				{ id: "todo", kind: "agent", zh: "待办与遗留", en: "TODOs & leftovers", pz: "扫描代码里的 TODO/FIXME，挑出最重要的 5 条。", pe: "Scan the code for TODO/FIXME and pick the five most important." },
				{ id: "brief", kind: "agent", zh: "生成简报", en: "Write the brief", pz: "合成一页简报：一句话总览、昨日进展、风险、今日建议。\n\n提交：{{commits}}\n\n待办：{{todo}}", pe: "Write a one-page brief: a one-line overview, yesterday's progress, risks and suggestions for today.\n\n Commits: {{commits}}\n\nTODOs: {{todo}}" },
				{ id: "end", kind: "end", zh: "结束", en: "End" },
			],
			[["start", "commits"], ["start", "todo"], ["commits", "brief"], ["todo", "brief"], ["brief", "end"]],
		),
	},
];
