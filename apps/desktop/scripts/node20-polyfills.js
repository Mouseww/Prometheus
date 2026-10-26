// APIs newer than Node 20 that the server's dependencies call. The shell loads this with --import, because a missing
// named export (fs.globSync) fails while modules link, before any code in main.js could patch it.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

if (!Promise.withResolvers)
	Promise.withResolvers = function () {
		let resolve, reject;
		const promise = new this((a, b) => {
			resolve = a;
			reject = b;
		});
		return { promise, resolve, reject };
	};
if (!Array.fromAsync)
	Array.fromAsync = async function (src, fn, thisArg) {
		const out = [];
		let i = 0;
		if (src[Symbol.asyncIterator] || src[Symbol.iterator]) {
			for await (const v of src) out.push(fn ? await fn.call(thisArg, v, i++) : v);
		} else {
			for (let n = src.length >>> 0; i < n; i++) {
				const v = await src[i];
				out.push(fn ? await fn.call(thisArg, v, i) : v);
			}
		}
		return out;
	};
if (!Object.groupBy)
	Object.groupBy = function (items, fn) {
		const o = Object.create(null);
		let i = 0;
		for (const v of items) (o[fn(v, i++)] ??= []).push(v);
		return o;
	};
if (!Map.groupBy)
	Map.groupBy = function (items, fn) {
		const m = new Map();
		let i = 0;
		for (const v of items) {
			const k = fn(v, i++);
			if (!m.has(k)) m.set(k, []);
			m.get(k).push(v);
		}
		return m;
	};

if (!fs.globSync) {
	const expandBraces = (p) => {
		const m = /\{([^{}]*)\}/.exec(p);
		if (!m) return [p];
		return m[1].split(",").flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
	};
	const BS = String.fromCharCode(92);
	const special = new RegExp("[.+^$()|" + BS + BS + "]", "g");
	const toRegExp = (g) => {
		let r = "";
		for (let i = 0; i < g.length; i++) {
			const c = g[i];
			if (c === "*") {
				if (g[i + 1] === "*") {
					i++;
					if (g[i + 1] === "/") {
						i++;
						r += "(?:.*/)?";
					} else r += ".*";
				} else r += "[^/]*";
			} else if (c === "?") r += "[^/]";
			else if (c === "[") {
				const j = g.indexOf("]", i + 1);
				if (j > i) {
					r += "[" + g.slice(i + 1, j).replace(/^!/, "^") + "]";
					i = j;
				} else r += BS + "[";
			} else r += c.replace(special, BS + "$&");
		}
		return new RegExp("^" + r + "$");
	};
	fs.globSync = function globSync(pattern, options = {}) {
		const cwd = options.cwd ? String(options.cwd) : process.cwd();
		const out = new Set();
		for (const pat of [].concat(pattern).flatMap(expandBraces)) {
			const segs = pat.split("/");
			const fixed = [];
			while (segs.length && !/[*?[]/.test(segs[0])) fixed.push(segs.shift());
			const base = path.join(cwd, ...fixed);
			const prefix = fixed.length ? fixed.join("/") + "/" : "";
			if (!segs.length) {
				if (fs.existsSync(base)) out.add(fixed.join("/"));
				continue;
			}
			const re = toRegExp(segs.join("/"));
			const walk = (dir, rel) => {
				let ents;
				try {
					ents = fs.readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const e of ents) {
					const r = rel ? rel + "/" + e.name : e.name;
					if (re.test(r)) out.add(prefix + r);
					if (e.isDirectory() && e.name !== "node_modules") walk(path.join(dir, e.name), r);
				}
			};
			walk(base, "");
		}
		return [...out];
	};
	syncBuiltinESMExports();
}
