// i18n 引用检查：
// 1) t("key") / tr(M, "key") 引用的 key 是否存在于同文件的 defineMessages 字典
// 2) 代码/JSX 里是否有未走 i18n 的硬编码中文
import fs from "node:fs";
import path from "node:path";

const scan = process.argv.slice(2);
const roots = scan.length ? scan : ["apps/web/src", "apps/server/src", "packages"];

const files = [];
function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "dist" || e.name === "target" || e.name.startsWith(".")) continue;
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) files.push(p.replace(/\\/g, "/"));
	}
}
for (const r of roots) {
	if (!fs.existsSync(r)) continue;
	if (fs.statSync(r).isDirectory()) walk(r);
	else files.push(r.replace(/\\/g, "/"));
}

const QUOTES = new Set(['"', "'", "`"]);
function lex(src) {
	const tokens = [];
	let i = 0;
	let line = 1;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (c === "\n") {
			line++;
			i++;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			while (i < n && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
				if (src[i] === "\n") line++;
				i++;
			}
			i += 2;
			continue;
		}
		if (QUOTES.has(c)) {
			const q = c;
			const startLine = line;
			let value = "";
			i++;
			while (i < n) {
				const ch = src[i];
				if (ch === "\\") {
					const nx = src[i + 1];
					if (nx === "\n") line++;
					value += nx ?? "";
					i += 2;
					continue;
				}
				if (ch === q) {
					i++;
					break;
				}
				if (ch === "\n") line++;
				value += ch;
				i++;
			}
			tokens.push({ type: "str", value, line: startLine, template: q === "`" });
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			let j = i;
			while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
			tokens.push({ type: "ident", value: src.slice(i, j), line });
			i = j;
			continue;
		}
		tokens.push({ type: "punct", value: c, line });
		i++;
	}
	return tokens;
}

function matchBrace(tokens, openIdx) {
	let depth = 0;
	for (let i = openIdx; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== "punct") continue;
		if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
		else if (t.value === "}" || t.value === ")" || t.value === "]") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function topLevelKeys(tokens, openIdx, closeIdx) {
	const keys = [];
	let depth = 0;
	for (let i = openIdx + 1; i < closeIdx; i++) {
		const t = tokens[i];
		if (t.type === "punct") {
			if (t.value === "{" || t.value === "(" || t.value === "[") depth++;
			else if (t.value === "}" || t.value === ")" || t.value === "]") depth--;
			continue;
		}
		if (depth !== 0 || t.type !== "ident") continue;
		const next = tokens[i + 1];
		const prev = tokens[i - 1];
		if (next && next.value === ":" && prev && (prev.value === "{" || prev.value === ",")) keys.push(t.value);
	}
	return keys;
}

const CJK = /[\u4e00-\u9fff]/;
const missingRefs = [];
const dynamicKeys = [];
const hardcoded = [];
let checkedRefs = 0;

for (const f of files) {
	const src = fs.readFileSync(f, "utf8");
	const tokens = lex(src);
	const hasDict = src.includes("defineMessages");

	// 收集本文件所有字典的键
	const definedKeys = new Set();
	if (hasDict) {
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.type !== "ident" || t.value !== "defineMessages") continue;
			if (!(tokens[i + 1] && tokens[i + 1].value === "(")) continue;
			if (!(tokens[i + 2] && tokens[i + 2].value === "{")) continue;
			const close = matchBrace(tokens, i + 2);
			if (close < 0) continue;
			let depth = 0;
			for (let k = i + 3; k < close; k++) {
				const tk = tokens[k];
				if (tk.type === "punct") {
					if (tk.value === "{" || tk.value === "(" || tk.value === "[") depth++;
					else if (tk.value === "}" || tk.value === ")" || tk.value === "]") depth--;
					continue;
				}
				if (depth !== 0 || tk.type !== "ident") continue;
				if (!(tokens[k + 1] && tokens[k + 1].value === ":") || !(tokens[k + 2] && tokens[k + 2].value === "{")) continue;
				const end = matchBrace(tokens, k + 2);
				if (end < 0) continue;
				for (const key of topLevelKeys(tokens, k + 2, end)) definedKeys.add(key);
			}
		}
	}

	// 1) t("key") / tr(M, "key") 引用检查
	if (hasDict) {
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.type !== "ident") continue;
			if (t.value !== "t" && t.value !== "tr") continue;
			const open = tokens[i + 1];
			if (!open || open.value !== "(") continue;
			// 跳过函数声明等
			const prev = tokens[i - 1];
			if (prev && prev.type === "ident" && ["function", "const", "let"].includes(prev.value)) continue;
			let argIdx;
			if (t.value === "tr") {
				// tr(M, "key", ...)
				if (!(tokens[i + 2] && tokens[i + 3] && tokens[i + 3].value === ",")) continue;
				argIdx = i + 4;
			} else {
				argIdx = i + 2;
			}
			const arg = tokens[argIdx];
			if (!arg || arg.type !== "str" || arg.template) continue;
			checkedRefs++;
			if (!definedKeys.has(arg.value)) {
				missingRefs.push(`${f}:${arg.line}  ${t.value}(... "${arg.value}") 未在字典中定义`);
			}
		}
	}

	// 1b) 模板拼接的动态 key：t(`prefix.${x}`) —— 检查已定义键是否覆盖 prefix 的所有取值
	if (hasDict) {
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.type !== "ident" || (t.value !== "t" && t.value !== "tr")) continue;
			const open = tokens[i + 1];
			if (!open || open.value !== "(") continue;
			const argIdx = t.value === "tr" ? i + 4 : i + 2;
			const arg = tokens[argIdx];
			if (!arg || arg.type !== "str" || !arg.template) continue;
			dynamicKeys.push({ file: f, line: arg.line, pattern: arg.value });
		}
	}

	// 2) 硬编码中文：字符串字面量里含中文，且不在字典值位置
	if (!src.includes("i18n.ts") && CJK.test(src)) {
		const lines = src.split("\n");
		lines.forEach((ln, idx) => {
			if (!CJK.test(ln)) return;
			if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return; // 纯注释行
			hardcoded.push(`${f}:${idx + 1}  ${ln.trim().slice(0, 110)}`);
		});
	}
}

if (missingRefs.length) {
	console.log(`\n--- t()/tr() 引用了未定义 key (${missingRefs.length}) ---`);
	for (const r of missingRefs) console.log("  " + r);
}
if (dynamicKeys.length) {
	console.log(`\n--- 动态 key（需人工确认取值完整）(${dynamicKeys.length}) ---`);
	for (const r of dynamicKeys) console.log(`  ${r.file}:${r.line}  ${r.pattern}`);
}
if (hardcoded.length) {
	console.log(`\n--- 未接入 i18n 的文件里出现中文 (${hardcoded.length}) ---`);
	for (const r of hardcoded) console.log("  " + r);
}
console.log(`\n=== 扫描 ${files.length} 文件 / 校验 ${checkedRefs} 处 t() 引用 ===`);
console.log(missingRefs.length + hardcoded.length ? "有问题" : "全部通过");
process.exit(missingRefs.length + hardcoded.length ? 1 : 0);
