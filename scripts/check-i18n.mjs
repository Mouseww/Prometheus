// i18n 完整性检查：对比 defineMessages 里 zh / en 字典的键是否一一对应
// 用法: node scripts/check-i18n.mjs [目录或文件...]
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

/** 词法切分：返回 token 列表 {type:'str'|'ident'|'punct'|'num'|'comment', value, line} */
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
			tokens.push({ type: "str", value, line: startLine });
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			let j = i;
			while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
			tokens.push({ type: "ident", value: src.slice(i, j), line });
			i = j;
			continue;
		}
		if (/[0-9]/.test(c)) {
			let j = i;
			while (j < n && /[0-9.eE]/.test(src[j])) j++;
			tokens.push({ type: "num", value: src.slice(i, j), line });
			i = j;
			continue;
		}
		// 多字符运算符
		const three = src.slice(i, i + 3);
		const two = src.slice(i, i + 2);
		if (["===", "!==", "..."].includes(three)) {
			tokens.push({ type: "punct", value: three, line });
			i += 3;
			continue;
		}
		if (["=>", "==", "!=", "??", "?."].includes(two)) {
			tokens.push({ type: "punct", value: two, line });
			i += 2;
			continue;
		}
		tokens.push({ type: "punct", value: c, line });
		i++;
	}
	return tokens;
}

/** 从 tokens[openIdx] 的 { 开始，返回匹配的 } 的下标 */
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

/** 提取对象字面量的顶层键（只认 depth==0 且后随 ':' 的标识符/字符串） */
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
		if (depth !== 0) continue;
		if (t.type !== "ident" && t.type !== "str") continue;
		const next = tokens[i + 1];
		const prev = tokens[i - 1];
		// 键必须紧跟 ':'，且前面是 '{' 或 ','
		if (next && next.type === "punct" && next.value === ":") {
			if (prev && prev.type === "punct" && (prev.value === "{" || prev.value === ",")) {
				keys.push({ key: t.value, line: t.line });
			}
		}
	}
	return keys;
}

let problems = 0;
let dictCount = 0;
let keyCount = 0;
const report = [];

for (const f of files) {
	const src = fs.readFileSync(f, "utf8");
	if (!src.includes("defineMessages")) continue;
	const tokens = lex(src);

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== "ident" || t.value !== "defineMessages") continue;
		// 跳过 import 语句里的 defineMessages
		const isImport = tokens.slice(Math.max(0, i - 12), i).some((x) => x.type === "ident" && x.value === "import");
		if (isImport && !(tokens[i + 1] && tokens[i + 1].value === "(")) continue;
		if (!(tokens[i + 1] && tokens[i + 1].type === "punct" && tokens[i + 1].value === "(")) continue;
		// 定位实参对象
		let j = i + 2;
		if (!(tokens[j] && tokens[j].type === "punct" && tokens[j].value === "{")) continue;
		const close = matchBrace(tokens, j);
		if (close < 0) continue;

		const dict = { zh: null, en: null, line: t.line };
		let depth = 0;
		for (let k = j + 1; k < close; k++) {
			const tk = tokens[k];
			if (tk.type === "punct") {
				if (tk.value === "{" || tk.value === "(" || tk.value === "[") depth++;
				else if (tk.value === "}" || tk.value === ")" || tk.value === "]") depth--;
				continue;
			}
			if (depth !== 0) continue;
			if (tk.type !== "ident" || (tk.value !== "zh" && tk.value !== "en")) continue;
			const colon = tokens[k + 1];
			const brace = tokens[k + 2];
			if (!(colon && colon.value === ":") || !(brace && brace.value === "{")) continue;
			const end = matchBrace(tokens, k + 2);
			if (end < 0) continue;
			dict[tk.value] = { keys: topLevelKeys(tokens, k + 2, end), line: tk.line };
		}

		dictCount++;
		keyCount += dict.zh?.keys.length ?? 0;
		if (!dict.zh || !dict.en) {
			problems++;
			report.push(`\n[缺整块] ${f}:${dict.line} 只有 ${dict.zh ? "zh" : ""}${dict.en ? "en" : ""}`);
			continue;
		}
		const zhMap = new Map();
		const dupZh = [];
		for (const { key, line } of dict.zh.keys) {
			if (zhMap.has(key)) dupZh.push(`${key}@L${line}`);
			zhMap.set(key, line);
		}
		const enMap = new Map();
		const dupEn = [];
		for (const { key, line } of dict.en.keys) {
			if (enMap.has(key)) dupEn.push(`${key}@L${line}`);
			enMap.set(key, line);
		}
		const missingEn = [...zhMap.keys()].filter((k) => !enMap.has(k));
		const missingZh = [...enMap.keys()].filter((k) => !zhMap.has(k));
		if (missingEn.length || missingZh.length || dupZh.length || dupEn.length) {
			problems++;
			report.push(`\n[${f}] defineMessages @L${dict.line} (zh ${zhMap.size} / en ${enMap.size})`);
			if (missingEn.length) report.push(`   缺英文 ${missingEn.length}: ${missingEn.join(", ")}`);
			if (missingZh.length) report.push(`   缺中文 ${missingZh.length}: ${missingZh.join(", ")}`);
			if (dupZh.length) report.push(`   重复键(zh): ${dupZh.join(", ")}`);
			if (dupEn.length) report.push(`   重复键(en): ${dupEn.join(", ")}`);
		}
	}
}

for (const r of report) console.log(r);
console.log(`\n=== 扫描 ${files.length} 文件 / ${dictCount} 组字典 / ${keyCount} 词条，问题 ${problems} 处 ===`);
process.exit(problems ? 1 : 0);
