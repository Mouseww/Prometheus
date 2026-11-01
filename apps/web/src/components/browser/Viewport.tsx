// The page itself: a canvas fed with the browser's frames, and a hidden textarea that turns the user's keyboard,
// IME and paste into input for the page. Everything Chromium does not draw headless (select popups, the context
// menu) is drawn here, in the DOM, so it layers with the rest of the app like any element.
import clsx from "clsx";
import { Check, Copy, ExternalLink, Link2, RotateCw, ArrowLeft, ArrowRight, ClipboardPaste, TextSelect, ImageIcon } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { defineMessages, useT } from "../../lib/i18n.ts";
import type { InputEvent, ViewMessage } from "./types.ts";
import { browserCall, type InputQueue } from "./useBrowser.ts";

const M = defineMessages({
	zh: {
		back: "后退",
		forward: "前进",
		reload: "重新加载",
		openLinkTab: "在新标签页中打开链接",
		copyLink: "复制链接地址",
		copyImage: "复制图片地址",
		openImage: "在新标签页中打开图片",
		copy: "复制",
		paste: "粘贴",
		selectAll: "全选",
	},
	en: {
		back: "Back",
		forward: "Forward",
		reload: "Reload",
		openLinkTab: "Open link in new tab",
		copyLink: "Copy link address",
		copyImage: "Copy image address",
		openImage: "Open image in new tab",
		copy: "Copy",
		paste: "Paste",
		selectAll: "Select all",
	},
});

type SelectMsg = Extract<ViewMessage, { k: "select" }>;
type MenuMsg = Extract<ViewMessage, { k: "menu" }>;

/** Where the page sits inside the canvas element, in CSS pixels. */
interface Layout {
	ox: number;
	oy: number;
	scale: number;
	fw: number;
	fh: number;
}

export interface ViewportHandle {
	draw(jpeg: Uint8Array, width: number, height: number): void;
	event(msg: Exclude<ViewMessage, { k: "state" } | { k: "frame" }>): void;
	focus(): void;
}

const CURSORS = new Set([
	"default", "pointer", "text", "wait", "progress", "crosshair", "move", "not-allowed", "help", "grab", "grabbing", "zoom-in", "zoom-out", "col-resize", "row-resize",
	"n-resize", "s-resize", "e-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "copy", "alias",
	"context-menu", "cell", "vertical-text", "all-scroll", "no-drop", "none",
]);

const modifiersOf = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right", "back", "forward"] as const;

interface Props {
	tab: string | null;
	queue: InputQueue;
	/** Input is held back (the agent is driving). */
	locked: boolean;
	/** Size the page should have, in CSS pixels; reported while the browser is headless. */
	onResize: (width: number, height: number, dpr: number) => void;
	/** The page is laid out as a phone: fingers go to it as touches (tap, scroll, pinch), not as a mouse. */
	touchMode: boolean;
	onNavigateAction: (action: "back" | "forward" | "reload") => void;
	onOpenTab: (url: string) => void;
	canGoBack: boolean;
	canGoForward: boolean;
}

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport({ tab, queue, locked, onResize, touchMode, onNavigateAction, onOpenTab, canGoBack, canGoForward }, ref) {
	const t = useT(M);
	const wrap = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const typing = useRef<HTMLTextAreaElement>(null);
	const layout = useRef<Layout>({ ox: 0, oy: 0, scale: 1, fw: 1, fh: 1 });
	const size = useRef({ w: 0, h: 0, dpr: 1 });
	const decoding = useRef(false);
	const pending = useRef<{ jpeg: Uint8Array; width: number; height: number } | null>(null);
	const last = useRef<ImageBitmap | null>(null);
	const composing = useRef(false);
	const clicks = useRef({ time: 0, x: 0, y: 0, button: -1, count: 0 });
	const touch = useRef<{ id: number; x: number; y: number; lastX: number; lastY: number; scrolling: boolean } | null>(null);
	// Fingers on the page in touch mode: pointer id -> point (the slot number is the touch id the page sees).
	const fingers = useRef(new Map<number, { slot: number; x: number; y: number }>());
	const [cursor, setCursor] = useState("default");
	const [select, setSelect] = useState<SelectMsg | null>(null);
	const [menu, setMenu] = useState<MenuMsg | null>(null);
	const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
	const [caret, setCaret] = useState({ x: 0, y: 0 });
	const [focused, setFocused] = useState(false);

	const paint = useCallback(() => {
		const c = canvas.current;
		const img = last.current;
		if (!c) return;
		const g = c.getContext("2d");
		if (!g) return;
		const { w, h, dpr } = size.current;
		g.fillStyle = getComputedStyle(c).getPropertyValue("--browser-backdrop") || "#141210";
		g.fillRect(0, 0, c.width, c.height);
		if (!img) return;
		const L = layout.current;
		// Frames are CSS-sized pages scaled to fit; headless pages match the panel, so the scale is 1.
		const scale = Math.min(w / L.fw, h / L.fh);
		const dw = L.fw * scale;
		const dh = L.fh * scale;
		L.scale = scale;
		L.ox = Math.max(0, (w - dw) / 2);
		L.oy = 0;
		g.imageSmoothingQuality = "high";
		g.drawImage(img, L.ox * dpr, L.oy * dpr, dw * dpr, dh * dpr);
	}, []);

	const decode = useCallback(
		async (jpeg: Uint8Array, width: number, height: number) => {
			decoding.current = true;
			try {
				const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
				last.current?.close();
				last.current = bmp;
				layout.current.fw = width || bmp.width;
				layout.current.fh = height || bmp.height;
				paint();
			} catch {
				// A corrupt frame is skipped; the next one replaces it.
			} finally {
				decoding.current = false;
				const next = pending.current;
				pending.current = null;
				if (next) void decode(next.jpeg, next.width, next.height);
			}
		},
		[paint],
	);

	const toContainer = (x: number, y: number) => ({ x: layout.current.ox + x * layout.current.scale, y: layout.current.oy + y * layout.current.scale });

	useImperativeHandle(
		ref,
		() => ({
			draw(jpeg, width, height) {
				// Only the newest frame matters: one waits while another decodes, older ones are dropped.
				if (decoding.current) pending.current = { jpeg, width, height };
				else void decode(jpeg, width, height);
			},
			event(msg) {
				switch (msg.k) {
					case "cursor":
						setCursor(CURSORS.has(msg.cursor) ? msg.cursor : "default");
						return;
					case "select":
						setMenu(null);
						setSelect(msg);
						return;
					case "menu":
						setSelect(null);
						setMenu(msg);
						return;
					case "copy":
						void copyToClipboard(msg.text).catch(() => {});
						return;
					case "pointer": {
						const p = toContainer(msg.x, msg.y);
						const id = Date.now() + Math.random();
						setRipples((r) => [...r.slice(-4), { id, ...p }]);
						setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 900);
						return;
					}
				}
			},
			focus() {
				typing.current?.focus({ preventScroll: true });
			},
		}),
		[decode],
	);

	// The panel's size is the page's size (headless): the canvas follows it at device resolution.
	useLayoutEffect(() => {
		const el = wrap.current;
		const c = canvas.current;
		if (!el || !c) return;
		let timer = 0;
		const ro = new ResizeObserver(() => {
			const r = el.getBoundingClientRect();
			const dpr = Math.min(window.devicePixelRatio || 1, 3);
			size.current = { w: r.width, h: r.height, dpr };
			c.width = Math.max(1, Math.round(r.width * dpr));
			c.height = Math.max(1, Math.round(r.height * dpr));
			paint();
			clearTimeout(timer);
			timer = window.setTimeout(() => onResize(Math.floor(r.width), Math.floor(r.height), dpr), 120);
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			clearTimeout(timer);
		};
	}, [paint, onResize]);

	useEffect(() => () => last.current?.close(), []);

	useEffect(() => {
		queue.tab = tab;
		setSelect(null);
		setMenu(null);
	}, [tab, queue]);

	const send = useCallback((e: InputEvent) => !locked && queue.push(e), [locked, queue]);

	const pagePoint = (clientX: number, clientY: number) => {
		const r = canvas.current?.getBoundingClientRect();
		const L = layout.current;
		if (!r) return { x: 0, y: 0 };
		return { x: (clientX - r.left - L.ox) / L.scale, y: (clientY - r.top - L.oy) / L.scale };
	};

	// Wheel needs a non-passive listener to keep the panel itself from scrolling.
	useEffect(() => {
		const c = canvas.current;
		if (!c) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const p = pagePoint(e.clientX, e.clientY);
			const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? size.current.h : 1;
			send({ k: "wheel", x: p.x, y: p.y, dx: e.deltaX * unit, dy: e.deltaY * unit, modifiers: modifiersOf(e) });
		};
		c.addEventListener("wheel", onWheel, { passive: false });
		return () => c.removeEventListener("wheel", onWheel);
	});

	const onPointerDown = (e: React.PointerEvent) => {
		setMenu(null);
		setSelect(null);
		const p = pagePoint(e.clientX, e.clientY);
		const r = wrap.current?.getBoundingClientRect();
		if (r) setCaret({ x: e.clientX - r.left, y: e.clientY - r.top });
		// Keyboard input goes through the hidden textarea; keep the focus there rather than on the canvas.
		e.preventDefault();
		typing.current?.focus({ preventScroll: true });
		if (e.pointerType === "touch" && touchMode) {
			canvas.current?.setPointerCapture(e.pointerId);
			const used = new Set([...fingers.current.values()].map((f) => f.slot));
			let slot = 0;
			while (used.has(slot)) slot++;
			fingers.current.set(e.pointerId, { slot, x: p.x, y: p.y });
			sendTouch("touchStart");
			return;
		}
		if (e.pointerType === "touch") {
			touch.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, scrolling: false };
			return;
		}
		canvas.current?.setPointerCapture(e.pointerId);
		const now = performance.now();
		const c = clicks.current;
		const same = now - c.time < 500 && Math.abs(e.clientX - c.x) < 5 && Math.abs(e.clientY - c.y) < 5 && c.button === e.button;
		clicks.current = { time: now, x: e.clientX, y: e.clientY, button: e.button, count: same ? c.count + 1 : 1 };
		send({ k: "mouse", type: "mousePressed", x: p.x, y: p.y, button: BUTTONS[e.button] ?? "left", buttons: e.buttons, clickCount: clicks.current.count, modifiers: modifiersOf(e) });
	};

	const sendTouch = (type: "touchStart" | "touchMove" | "touchEnd") => {
		const points = type === "touchEnd" && fingers.current.size === 0 ? [] : [...fingers.current.values()].map((f) => ({ x: f.x, y: f.y, id: f.slot }));
		send({ k: "touch", type, points });
	};

	const onPointerMove = (e: React.PointerEvent) => {
		const p = pagePoint(e.clientX, e.clientY);
		const finger = fingers.current.get(e.pointerId);
		if (e.pointerType === "touch" && finger) {
			finger.x = p.x;
			finger.y = p.y;
			sendTouch("touchMove");
			return;
		}
		const tt = touch.current;
		if (e.pointerType === "touch" && tt && tt.id === e.pointerId) {
			if (!tt.scrolling && Math.hypot(e.clientX - tt.x, e.clientY - tt.y) > 8) tt.scrolling = true;
			if (tt.scrolling) {
				send({ k: "wheel", x: p.x, y: p.y, dx: (tt.lastX - e.clientX) / layout.current.scale, dy: (tt.lastY - e.clientY) / layout.current.scale });
				tt.lastX = e.clientX;
				tt.lastY = e.clientY;
			}
			return;
		}
		send({ k: "mouse", type: "mouseMoved", x: p.x, y: p.y, button: e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : "none", buttons: e.buttons, modifiers: modifiersOf(e) });
	};

	const onPointerUp = (e: React.PointerEvent) => {
		const p = pagePoint(e.clientX, e.clientY);
		if (e.pointerType === "touch" && fingers.current.has(e.pointerId)) {
			fingers.current.delete(e.pointerId);
			// The last finger lifting ends the gesture; with others still down the remaining points carry on.
			sendTouch(fingers.current.size === 0 ? "touchEnd" : "touchMove");
			return;
		}
		const tt = touch.current;
		if (e.pointerType === "touch" && tt && tt.id === e.pointerId) {
			touch.current = null;
			if (!tt.scrolling) {
				send({ k: "mouse", type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
				send({ k: "mouse", type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
			}
			return;
		}
		send({ k: "mouse", type: "mouseReleased", x: p.x, y: p.y, button: BUTTONS[e.button] ?? "left", buttons: e.buttons, clickCount: clicks.current.count, modifiers: modifiersOf(e) });
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (composing.current || e.nativeEvent.isComposing || e.key === "Process" || e.keyCode === 229) return;
		const accel = e.ctrlKey || e.metaKey;
		// Paste arrives as a paste event with the user's clipboard; the key itself would paste the page's own.
		if (accel && !e.altKey && e.key.toLowerCase() === "v") return;
		e.preventDefault();
		// AltGr arrives as Ctrl+Alt on Windows and still types a character; Option on a Mac types one too.
		const altGr = e.ctrlKey && e.altKey;
		const printable = e.key.length === 1 && (!accel || altGr);
		const text = printable ? e.key : e.key === "Enter" ? "\r" : undefined;
		send({ k: "key", type: text ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, keyCode: e.keyCode, ...(text ? { text } : {}), modifiers: modifiersOf(e), location: e.location, repeat: e.repeat });
	};

	const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
		send({ k: "key", type: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: modifiersOf(e), location: e.location });
	};

	const clearTyping = () => {
		if (typing.current) typing.current.value = "";
	};

	const pasteText = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text) send({ k: "text", text });
		} catch {
			// Clipboard read needs permission; Ctrl+V still works.
		}
	};

	const menuAt = menu ? toContainer(menu.x, menu.y) : null;
	const selectAt = select ? toContainer(select.rect[0], select.rect[1] + select.rect[3]) : null;
	const close = () => {
		setMenu(null);
		setSelect(null);
		typing.current?.focus({ preventScroll: true });
	};

	return (
		<div ref={wrap} className={clsx("browser-viewport absolute inset-0 overflow-hidden", focused && "is-focused")}>
			<canvas
				ref={canvas}
				className="absolute inset-0 h-full w-full touch-none select-none"
				style={{ cursor: locked ? "not-allowed" : cursor }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={(e) => {
					touch.current = null;
					if (fingers.current.delete(e.pointerId) && fingers.current.size === 0) send({ k: "touch", type: "touchCancel", points: [] });
				}}
				onContextMenu={(e) => e.preventDefault()}
				onDragStart={(e) => e.preventDefault()}
			/>
			<textarea
				ref={typing}
				aria-label="page input"
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
				className="pointer-events-none absolute size-px resize-none border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
				style={{ left: caret.x, top: caret.y }}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				onCompositionStart={() => (composing.current = true)}
				onCompositionUpdate={(e) => send({ k: "ime", text: e.data, start: e.data.length, end: e.data.length })}
				onCompositionEnd={(e) => {
					composing.current = false;
					if (e.data) send({ k: "text", text: e.data });
					clearTyping();
				}}
				onInput={(e) => {
					// Phones' soft keyboards often send text without key events.
					const el = e.currentTarget;
					if (composing.current || !el.value) return;
					send({ k: "text", text: el.value });
					clearTyping();
				}}
				onPaste={(e) => {
					e.preventDefault();
					const text = e.clipboardData.getData("text/plain");
					if (text) send({ k: "text", text });
				}}
			/>

			{ripples.map((r) => (
				<span key={r.id} className="browser-ripple pointer-events-none absolute" style={{ left: r.x, top: r.y }} />
			))}

			{select && selectAt && (
				<>
					<div className="absolute inset-0 z-10" onMouseDown={close} />
					<div
						className="absolute z-20 max-h-72 min-w-32 overflow-y-auto rounded-lg border border-ink-700 bg-ink-900 py-1 text-sm shadow-xl shadow-black/40"
						style={{ left: Math.min(selectAt.x, (size.current.w || 300) - 200), top: Math.min(selectAt.y + 2, Math.max(8, (size.current.h || 300) - 300)), minWidth: Math.max(128, select.rect[2] * layout.current.scale) }}
						onKeyDown={(e) => e.key === "Escape" && close()}
					>
						{select.options.map((o, i) => (
							<div key={i}>
								{o.group && o.group !== select.options[i - 1]?.group && <div className="px-3 pt-1.5 pb-0.5 text-[11px] font-semibold text-ink-500">{o.group}</div>}
								<button
									type="button"
									disabled={o.disabled}
									onClick={() => {
										void browserCall("select", { tab, index: i }).catch(() => {});
										close();
									}}
									className={clsx("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-ink-800 disabled:opacity-40", o.group && "pl-5", o.selected ? "text-ember-300" : "text-ink-200")}
								>
									<Check className={clsx("size-3.5 shrink-0", !o.selected && "invisible")} />
									<span className="truncate">{o.label || "\u00a0"}</span>
								</button>
							</div>
						))}
					</div>
				</>
			)}

			{menu && menuAt && (
				<>
					<div className="absolute inset-0 z-10" onMouseDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
					<div
						className="absolute z-20 w-56 animate-rise rounded-lg border border-ink-700 bg-ink-900 p-1 text-[13px] shadow-xl shadow-black/40"
						style={{ left: Math.min(menuAt.x, (size.current.w || 300) - 232), top: Math.min(menuAt.y, Math.max(8, (size.current.h || 300) - 260)) }}
					>
						{menu.link && (
							<>
								<MenuItem icon={<ExternalLink />} label={t("openLinkTab")} onClick={() => (onOpenTab(menu.link as string), close())} />
								<MenuItem icon={<Link2 />} label={t("copyLink")} onClick={() => (void copyToClipboard(menu.link as string), close())} />
								<hr className="my-1 border-ink-800" />
							</>
						)}
						{menu.image && (
							<>
								<MenuItem icon={<ImageIcon />} label={t("openImage")} onClick={() => (onOpenTab(menu.image as string), close())} />
								<MenuItem icon={<Copy />} label={t("copyImage")} onClick={() => (void copyToClipboard(menu.image as string), close())} />
								<hr className="my-1 border-ink-800" />
							</>
						)}
						{menu.selection && <MenuItem icon={<Copy />} label={t("copy")} onClick={() => (void copyToClipboard(menu.selection as string), close())} />}
						{menu.editable && <MenuItem icon={<ClipboardPaste />} label={t("paste")} onClick={() => (close(), void pasteText())} />}
						{menu.editable && (
							<MenuItem
								icon={<TextSelect />}
								label={t("selectAll")}
								onClick={() => {
									close();
									const mac = navigator.platform.startsWith("Mac");
									send({ k: "key", type: "rawKeyDown", key: "a", code: "KeyA", keyCode: 65, modifiers: mac ? 4 : 2 });
									send({ k: "key", type: "keyUp", key: "a", code: "KeyA", keyCode: 65, modifiers: mac ? 4 : 2 });
								}}
							/>
						)}
						{(menu.selection || menu.editable) && <hr className="my-1 border-ink-800" />}
						<MenuItem icon={<ArrowLeft />} label={t("back")} disabled={!canGoBack} onClick={() => (onNavigateAction("back"), close())} />
						<MenuItem icon={<ArrowRight />} label={t("forward")} disabled={!canGoForward} onClick={() => (onNavigateAction("forward"), close())} />
						<MenuItem icon={<RotateCw />} label={t("reload")} onClick={() => (onNavigateAction("reload"), close())} />
					</div>
				</>
			)}
		</div>
	);
});

function MenuItem({ icon, label, onClick, disabled }: { icon: React.ReactElement<{ className?: string }>; label: string; onClick: () => void; disabled?: boolean }) {
	return (
		<button type="button" disabled={disabled} onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ink-200 hover:bg-ink-800 disabled:opacity-40 disabled:hover:bg-transparent [&>svg]:size-3.5 [&>svg]:text-ink-400">
			{icon}
			{label}
		</button>
	);
}
