import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "prometheus.panelWidth.";
/** Room the chat column keeps, so a panel dragged wide can never squeeze it out. */
const CHAT_MIN = 360;

export type PanelWidthOptions = {
	min: number;
	max: number;
	/** Which edge of the panel carries the handle: dragging a left edge to the left widens the panel. */
	edge: "left" | "right";
};

function load(key: string, clamp: (n: number) => number): number | null {
	try {
		const n = Number(localStorage.getItem(PREFIX + key));
		return Number.isFinite(n) && n > 0 ? clamp(n) : null;
	} catch {
		return null;
	}
}

/**
 * A panel width in px that the user can drag, persisted per `key`. `width` is null until the user has chosen one,
 * so the panel keeps its own responsive default. `handleProps` goes on a handle that is a direct child of the panel.
 */
export function usePanelWidth(key: string, { min, max, edge }: PanelWidthOptions) {
	const clamp = useCallback((n: number) => Math.round(Math.min(Math.max(min, Math.min(max, window.innerWidth - CHAT_MIN)), Math.max(min, n))), [min, max]);
	const [width, setWidth] = useState<number | null>(() => load(key, clamp));
	const [dragging, setDragging] = useState(false);
	const latest = useRef(width);
	latest.current = width;
	const drag = useRef<{ x: number; w: number } | null>(null);

	const save = (n: number | null) => {
		try {
			if (n === null) localStorage.removeItem(PREFIX + key);
			else localStorage.setItem(PREFIX + key, String(n));
		} catch {}
	};

	const onPointerDown = (e: PointerEvent<HTMLElement>) => {
		const panel = e.currentTarget.parentElement;
		if (!panel) return;
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		drag.current = { x: e.clientX, w: panel.getBoundingClientRect().width };
		setDragging(true);
	};
	const onPointerMove = (e: PointerEvent<HTMLElement>) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.x;
		setWidth(clamp(d.w + (edge === "right" ? dx : -dx)));
	};
	const end = () => {
		if (!drag.current) return;
		drag.current = null;
		setDragging(false);
		save(latest.current);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		const base = latest.current ?? e.currentTarget.parentElement?.getBoundingClientRect().width ?? min;
		const grow = (e.key === "ArrowRight") === (edge === "right");
		const next = clamp(base + (grow ? 16 : -16));
		setWidth(next);
		save(next);
	};
	const reset = () => {
		setWidth(null);
		save(null);
	};

	// Keep the page from selecting text / flashing a text cursor while dragging.
	useEffect(() => {
		if (!dragging) return;
		const prev = document.body.style.cursor;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			document.body.style.cursor = prev;
			document.body.style.userSelect = "";
		};
	}, [dragging]);

	return {
		width,
		dragging,
		min,
		max,
		edge,
		handleProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onDoubleClick: reset, onKeyDown },
	};
}

export type PanelWidth = ReturnType<typeof usePanelWidth>;
