// Key definitions for Input.dispatchKeyEvent, and the "ctrl+shift+t" combo syntax the agent uses.

export interface KeyDef {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
	location?: number;
	/** Key value while Shift is held. */
	shiftKey?: string;
}

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

const DEFS = new Map<string, KeyDef>();
const put = (name: string, def: KeyDef) => DEFS.set(name.toLowerCase(), def);

for (let i = 0; i < 26; i++) {
	const c = String.fromCharCode(97 + i);
	const C = c.toUpperCase();
	put(c, { key: c, code: `Key${C}`, keyCode: 65 + i, text: c, shiftKey: C });
}
const SHIFT_DIGITS = ")!@#$%^&*(";
for (let i = 0; i < 10; i++) put(String(i), { key: String(i), code: `Digit${i}`, keyCode: 48 + i, text: String(i), shiftKey: SHIFT_DIGITS[i] });
for (let i = 1; i <= 12; i++) put(`f${i}`, { key: `F${i}`, code: `F${i}`, keyCode: 111 + i });

const NAMED: [string[], KeyDef][] = [
	[["enter", "return"], { key: "Enter", code: "Enter", keyCode: 13, text: "\r" }],
	[["tab"], { key: "Tab", code: "Tab", keyCode: 9 }],
	[["backspace"], { key: "Backspace", code: "Backspace", keyCode: 8 }],
	[["escape", "esc"], { key: "Escape", code: "Escape", keyCode: 27 }],
	[["space", " "], { key: " ", code: "Space", keyCode: 32, text: " " }],
	[["delete", "del"], { key: "Delete", code: "Delete", keyCode: 46 }],
	[["insert", "ins"], { key: "Insert", code: "Insert", keyCode: 45 }],
	[["home"], { key: "Home", code: "Home", keyCode: 36 }],
	[["end"], { key: "End", code: "End", keyCode: 35 }],
	[["pageup", "pgup"], { key: "PageUp", code: "PageUp", keyCode: 33 }],
	[["pagedown", "pgdn"], { key: "PageDown", code: "PageDown", keyCode: 34 }],
	[["arrowleft", "left"], { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }],
	[["arrowup", "up"], { key: "ArrowUp", code: "ArrowUp", keyCode: 38 }],
	[["arrowright", "right"], { key: "ArrowRight", code: "ArrowRight", keyCode: 39 }],
	[["arrowdown", "down"], { key: "ArrowDown", code: "ArrowDown", keyCode: 40 }],
	[["shift"], { key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 }],
	[["ctrl", "control"], { key: "Control", code: "ControlLeft", keyCode: 17, location: 1 }],
	[["alt", "option"], { key: "Alt", code: "AltLeft", keyCode: 18, location: 1 }],
	[["meta", "cmd", "command", "win", "super"], { key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 }],
	[["-", "minus"], { key: "-", code: "Minus", keyCode: 189, text: "-", shiftKey: "_" }],
	[["=", "equal"], { key: "=", code: "Equal", keyCode: 187, text: "=", shiftKey: "+" }],
	[["[", "bracketleft"], { key: "[", code: "BracketLeft", keyCode: 219, text: "[", shiftKey: "{" }],
	[["]", "bracketright"], { key: "]", code: "BracketRight", keyCode: 221, text: "]", shiftKey: "}" }],
	[["\\", "backslash"], { key: "\\", code: "Backslash", keyCode: 220, text: "\\", shiftKey: "|" }],
	[[";", "semicolon"], { key: ";", code: "Semicolon", keyCode: 186, text: ";", shiftKey: ":" }],
	[["'", "quote"], { key: "'", code: "Quote", keyCode: 222, text: "'", shiftKey: '"' }],
	[[",", "comma"], { key: ",", code: "Comma", keyCode: 188, text: ",", shiftKey: "<" }],
	[[".", "period"], { key: ".", code: "Period", keyCode: 190, text: ".", shiftKey: ">" }],
	[["/", "slash"], { key: "/", code: "Slash", keyCode: 191, text: "/", shiftKey: "?" }],
	[["`", "backquote"], { key: "`", code: "Backquote", keyCode: 192, text: "`", shiftKey: "~" }],
	[["plus"], { key: "+", code: "Equal", keyCode: 187, text: "+" }],
];
for (const [names, def] of NAMED) for (const n of names) put(n, def);

const MOD_NAMES: Record<string, keyof typeof MOD> = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift", meta: "meta", cmd: "meta", command: "meta", win: "meta", super: "meta" };

export interface Combo {
	modifiers: number;
	key: KeyDef;
	/** Modifier keys pressed before the key, in order. */
	held: KeyDef[];
}

/** "ctrl+shift+t" → modifiers + key. Throws on an unknown key name. */
export function parseCombo(combo: string): Combo {
	const parts = combo.trim().split(/\+(?!$)/).map((p) => p.trim()).filter(Boolean);
	if (!parts.length) throw new Error(`无效的按键：${combo}`);
	const last = parts.pop() as string;
	let modifiers = 0;
	const held: KeyDef[] = [];
	for (const p of parts) {
		const m = MOD_NAMES[p.toLowerCase()];
		if (!m) throw new Error(`未知的修饰键：${p}`);
		modifiers |= MOD[m];
		held.push(DEFS.get(p.toLowerCase()) as KeyDef);
	}
	const key = DEFS.get(last.toLowerCase()) ?? (last.length === 1 ? { key: last, code: "", keyCode: last.toUpperCase().charCodeAt(0), text: last } : undefined);
	if (!key) throw new Error(`未知的按键：${last}`);
	return { modifiers, key, held };
}

/** macOS Chromium does not run editing shortcuts from synthetic key events unless told the command. */
const MAC_COMMANDS: Record<string, string[]> = {
	KeyA: ["selectAll"],
	KeyC: ["copy"],
	KeyX: ["cut"],
	KeyV: ["paste"],
	KeyZ: ["undo"],
};

export function editingCommands(code: string, modifiers: number, platform: NodeJS.Platform = process.platform): string[] | undefined {
	if (platform !== "darwin" || !(modifiers & MOD.meta)) return undefined;
	if (code === "KeyZ" && modifiers & MOD.shift) return ["redo"];
	return MAC_COMMANDS[code];
}

export type KeyEventParams = Record<string, unknown> & { type: string };

/** The dispatchKeyEvent calls for one combo: modifiers down, key down/up, modifiers up. */
export function comboEvents(combo: Combo, platform: NodeJS.Platform = process.platform): KeyEventParams[] {
	const out: KeyEventParams[] = [];
	let mods = 0;
	for (const h of combo.held) {
		mods |= modBit(h.key);
		out.push({ type: "rawKeyDown", key: h.key, code: h.code, windowsVirtualKeyCode: h.keyCode, location: h.location ?? 0, modifiers: mods });
	}
	const k = combo.key;
	const shifted = combo.modifiers & MOD.shift && k.shiftKey ? k.shiftKey : k.key;
	// Text is only produced when no shortcut modifier is held (ctrl+a selects, it does not type "a").
	const typing = !(combo.modifiers & (MOD.ctrl | MOD.meta | MOD.alt));
	const text = typing ? (k.text === undefined ? undefined : k.shiftKey && combo.modifiers & MOD.shift ? k.shiftKey : k.text) : undefined;
	const commands = editingCommands(k.code, combo.modifiers, platform);
	out.push({
		type: text ? "keyDown" : "rawKeyDown",
		key: shifted,
		code: k.code,
		windowsVirtualKeyCode: k.keyCode,
		location: k.location ?? 0,
		modifiers: combo.modifiers,
		...(text ? { text, unmodifiedText: k.text } : {}),
		...(commands ? { commands } : {}),
	});
	out.push({ type: "keyUp", key: shifted, code: k.code, windowsVirtualKeyCode: k.keyCode, location: k.location ?? 0, modifiers: combo.modifiers });
	for (const h of [...combo.held].reverse()) {
		mods &= ~modBit(h.key);
		out.push({ type: "keyUp", key: h.key, code: h.code, windowsVirtualKeyCode: h.keyCode, location: h.location ?? 0, modifiers: mods });
	}
	return out;
}

function modBit(key: string): number {
	return key === "Alt" ? MOD.alt : key === "Control" ? MOD.ctrl : key === "Meta" ? MOD.meta : key === "Shift" ? MOD.shift : 0;
}
