// Isolated demo environment for product screenshots.
// Starts a scripted OpenAI-compatible model on :7440 and a throwaway Prometheus server on :7430
// whose data lives in a temp dir, so nothing from the real ~/.prometheus or ~/.pi leaks into shots.
//   node scripts/promo/demo-env.mjs          (PROMO_LANG=en for English content)
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(join(repo, "apps/server/package.json"));
const { WebSocket } = require("ws");

const EN = process.env.PROMO_LANG === "en";
const LLM_PORT = 7440;
const PORT = Number(process.env.PROMO_PORT ?? 7430);
const root = join(tmpdir(), "prometheus-promo");
rmSync(root, { recursive: true, force: true });
const home = join(root, "home");
const piDir = join(root, "pi-agent");
const demo = join(root, "demo");
for (const d of [home, piDir, demo]) mkdirSync(d, { recursive: true });
writeFileSync(join(demo, "README.md"), EN ? "# demo\n\nPrometheus demo project.\n" : "# demo\n\nPrometheus 演示项目。\n");
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: demo });

// ---------- scripted model ----------
const FIZZ = `def fizzbuzz(n: int) -> str:
    if n % 15 == 0:
        return "FizzBuzz"
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    return str(n)


if __name__ == "__main__":
    print(" ".join(fizzbuzz(i) for i in range(1, 16)))
`;
const FINAL_ZH = `完成，脚本运行通过。

## 结果

- 新增 \`fizzbuzz.py\`，带类型标注的 \`fizzbuzz()\` 函数
- 输出 1–15 的 FizzBuzz 序列，无报错

| 文件 | 说明 |
| --- | --- |
| \`fizzbuzz.py\` | FizzBuzz 实现与入口 |

需要我再补一组 pytest 单元测试吗？`;
const FINAL_EN = `Done, the script runs cleanly.

## Result

- Added \`fizzbuzz.py\` with a typed \`fizzbuzz()\` function
- Prints the FizzBuzz sequence for 1–15 without errors

| File | Purpose |
| --- | --- |
| \`fizzbuzz.py\` | FizzBuzz implementation and entry point |

Want me to add a set of pytest unit tests as well?`;
const T = EN
	? { task: "Write a FizzBuzz script and run it", first: "Sure, let me write a FizzBuzz script first.", second: "Created `fizzbuzz.py`, now let me run it.", final: FINAL_EN }
	: { task: "写一个 FizzBuzz 脚本并运行验证", first: "好的，我先写一个 FizzBuzz 脚本。", second: "已创建 `fizzbuzz.py`，现在运行验证一下。", final: FINAL_ZH };

function script(body) {
	const msgs = body.messages ?? [];
	if (!body.tools?.length) return { text: T.task }; // title / summary requests
	const lastUser = msgs.map((m, i) => [m, i]).filter(([m]) => m.role === "user").pop()?.[1] ?? 0;
	const toolResults = msgs.slice(lastUser).filter((m) => m.role === "tool").length;
	if (toolResults === 0) return { text: T.first, tool: { name: "write", args: { path: "fizzbuzz.py", content: FIZZ } } };
	if (toolResults === 1) return { text: T.second, tool: { name: "bash", args: { command: "python fizzbuzz.py" } } };
	return { text: T.final };
}

const llm = createServer(async (req, res) => {
	if (req.method === "GET" && req.url.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ data: [{ id: "demo-pro" }, { id: "demo-mini" }] }));
	}
	let raw = "";
	for await (const c of req) raw += c;
	const body = raw ? JSON.parse(raw) : {};
	const step = script(body);
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const base = { id: "chatcmpl-demo", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "demo-pro" };
	const send = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	send({ role: "assistant", content: "" });
	for (const chunk of step.text.match(/[\s\S]{1,6}/g) ?? []) {
		send({ content: chunk });
		await sleep(15);
	}
	if (step.tool) send({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] });
	send({}, step.tool ? "tool_calls" : "stop");
	res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 3120, completion_tokens: 410, total_tokens: 3530 } })}\n\n`);
	res.end("data: [DONE]\n\n");
});
await new Promise((r) => llm.listen(LLM_PORT, "127.0.0.1", r));
console.log(`[promo] model on :${LLM_PORT}`);

// ---------- isolated server ----------
const server = spawn(process.execPath, [join(repo, "apps/server/src/main.ts")], {
	cwd: demo,
	env: {
		...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PROMETHEUS_") && !k.startsWith("PI_"))),
		PROMETHEUS_HOME: home,
		PI_CODING_AGENT_DIR: piDir,
		PROMETHEUS_PORT: String(PORT),
		PROMETHEUS_HOST: "127.0.0.1",
		PROMETHEUS_CWD: demo,
		PROMETHEUS_WEB_ROOT: join(repo, "apps/web/dist"),
		PROMETHEUS_TOKEN: "",
	},
	stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => { server.kill(); llm.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (c) => { console.log(`[promo] server exited ${c}`); process.exit(1); });

async function connect() {
	for (let i = 0; i < 120; i++) {
		try {
			const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			await new Promise((ok, bad) => { ws.once("open", ok); ws.once("error", bad); });
			return ws;
		} catch { await new Promise((r) => setTimeout(r, 500)); }
	}
	throw new Error("server did not come up");
}
const ws = await connect();
let seq = 0;
const pending = new Map();
ws.on("message", (raw) => { const f = JSON.parse(raw.toString()); if (f.type === "response") pending.get(f.id)?.(f); });
const rpc = (method, params = {}) => new Promise((ok, bad) => {
	const id = `p${++seq}`;
	pending.set(id, (f) => (f.ok ? ok(f.data) : bad(new Error(`${method}: ${f.error}`))));
	ws.send(JSON.stringify({ type: "rpc", id, method, params }));
});
const plug = (plugin, method, params = {}) => rpc("plugin.call", { plugin, method, params });

await rpc("gateway.save", { gateway: {
	id: "demo", name: "Demo Gateway", format: "openai-completions", baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, auth: { type: "none" },
	models: [{ id: "demo-pro", name: "demo-pro", contextWindow: 200000, maxTokens: 16000 }, { id: "demo-mini", name: "demo-mini", contextWindow: 128000, maxTokens: 8000 }],
} });
const skills = EN ? [
	["api-design", "Consistent naming, pagination and error conventions for REST / GraphQL APIs."],
	["release-notes", "Generate Keep a Changelog release notes from commit history."],
	["code-review", "Review diffs for correctness, security and readability."],
	["e2e-testing", "Write stable Playwright end-to-end tests without hard waits."],
] : [
	["api-design", "设计 REST / GraphQL 接口时遵循一致的命名、分页与错误约定。"],
	["release-notes", "根据提交记录生成 Keep a Changelog 格式的发布说明。"],
	["code-review", "按正确性、安全、可读性三层给出 diff 评审意见。"],
	["e2e-testing", "用 Playwright 编写稳定的端到端测试，避免硬等待。"],
];
for (const [name, description] of skills) await plug("skills", "create", { name, description, body: `# ${name}\n\n${description}\n` }).catch((e) => console.log(String(e)));
for (const content of EN ? ["Prefers pnpm and TypeScript strict mode", "Commit messages follow Conventional Commits"] : ["用户偏好 pnpm 与 TypeScript 严格模式", "提交信息使用 Conventional Commits"]) await plug("memory", "add", { content, tags: ["demo"], scope: "user" }).catch((e) => console.log(String(e)));
await rpc("session.create", { cwd: demo }).catch((e) => console.log(String(e)));
console.log(`[promo] ready http://127.0.0.1:${PORT}  data=${root}`);
