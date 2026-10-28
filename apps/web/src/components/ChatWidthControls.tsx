import clsx from "clsx";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { CHAT_WIDTH_EDGE, CHAT_WIDTH_MIN, CHAT_WIDTH_VAR, preferenceFromDrag, resolveChatWidth } from "../lib/chatWidth.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { setPrefs, usePrefs } from "../lib/prefs.ts";

const M = defineMessages({
	zh: { hint: "拖动调整对话宽度，双击恢复默认" },
	en: { hint: "Drag to resize the chat width, double-click to reset" },
});

interface Handlers {
	start: () => number;
	drag: (width: number) => void;
	commit: (width: number) => void;
	end: () => void;
	reset: () => void;
}

function Handle({ side, h }: { side: "left" | "right"; h: Handlers }) {
	const t = useT(M);
	const [dragging, setDragging] = useState(false);
	const s = useRef({ base: 0, origin: 0, latest: 0, frame: 0 });
	const hRef = useRef(h);
	hRef.current = h;

	// Both sides move together, so the column grows by twice the pointer travel.
	const width = () => s.current.base + (side === "right" ? 1 : -1) * (s.current.latest - s.current.origin) * 2;
	const finish = () => {
		cancelAnimationFrame(s.current.frame);
		s.current.frame = 0;
		setDragging(false);
		document.documentElement.removeAttribute("data-chat-resizing");
		hRef.current.end();
	};

	return (
		<div
			data-handle={side}
			title={t("hint")}
			className={clsx("group/h absolute top-0 bottom-0 z-[5] w-4 cursor-col-resize touch-none max-md:hidden", dragging && "z-10")}
			style={side === "left" ? { right: `calc(50% + var(${CHAT_WIDTH_VAR}) / 2 + 4px)` } : { left: `calc(50% + var(${CHAT_WIDTH_VAR}) / 2 + 4px)` }}
			onDoubleClick={() => hRef.current.reset()}
			onPointerDown={(e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				e.currentTarget.setPointerCapture(e.pointerId);
				s.current.origin = s.current.latest = e.clientX;
				s.current.base = hRef.current.start();
				setDragging(true);
				// Turns off the width transition so the column follows the pointer.
				document.documentElement.setAttribute("data-chat-resizing", "");
			}}
			onPointerMove={(e) => {
				if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
				s.current.latest = e.clientX;
				s.current.frame ||= requestAnimationFrame(() => {
					s.current.frame = 0;
					hRef.current.drag(width());
				});
			}}
			onPointerUp={(e) => {
				if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
				e.currentTarget.releasePointerCapture(e.pointerId);
				s.current.latest = e.clientX;
				// Only a real move counts, so a plain click can't overwrite a saved width.
				if (s.current.latest !== s.current.origin) hRef.current.commit(width());
				finish();
			}}
			onPointerCancel={finish}
		>
			<span
				aria-hidden
				className={clsx(
					"pointer-events-none absolute inset-y-6 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-ember-400 transition-opacity duration-150",
					dragging ? "opacity-100" : "opacity-0 group-hover/h:opacity-70",
				)}
			/>
		</div>
	);
}

/** Publishes --chat-width on `container` and renders a drag handle on each side of the chat column. */
export function ChatWidthControls({ container }: { container: HTMLElement | null }) {
	const preference = usePrefs((p) => p.chatWidth);
	const column = useRef(0);
	const startRef = useRef({ preference: 0, display: 0 });
	// A column narrower than the minimum width has nothing to resize, and the handles would land outside it.
	const [resizable, setResizable] = useState(true);

	const publish = useCallback(
		(width?: number) => {
			if (!container) return;
			column.current = container.offsetWidth;
			setResizable(column.current >= CHAT_WIDTH_MIN + CHAT_WIDTH_EDGE);
			container.style.setProperty(CHAT_WIDTH_VAR, `${resolveChatWidth(column.current, width ?? usePrefs.getState().chatWidth)}px`);
		},
		[container],
	);

	useLayoutEffect(() => {
		if (!container) return;
		const ro = new ResizeObserver(() => publish());
		ro.observe(container);
		publish();
		return () => ro.disconnect();
	}, [container, publish, preference]);

	const handlers: Handlers = {
		start: () => {
			column.current = container?.offsetWidth ?? 0;
			const pref = usePrefs.getState().chatWidth;
			const display = resolveChatWidth(column.current, pref);
			startRef.current = { preference: pref ?? display, display };
			return display;
		},
		drag: (w) => container?.style.setProperty(CHAT_WIDTH_VAR, `${resolveChatWidth(column.current, w)}px`),
		commit: (w) => setPrefs({ chatWidth: preferenceFromDrag(column.current, startRef.current.preference, startRef.current.display, w) }),
		end: () => publish(),
		reset: () => setPrefs({ chatWidth: null }),
	};

	if (!container || !resizable) return null;
	return (
		<>
			<Handle side="left" h={handlers} />
			<Handle side="right" h={handlers} />
		</>
	);
}
