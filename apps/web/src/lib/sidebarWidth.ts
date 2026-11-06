import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "prometheus.sidebarWidth";
export const SIDEBAR_DEFAULT = 288;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 560;

const clamp = (n: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)));

function load(): number {
	try {
		const n = Number(localStorage.getItem(KEY));
		return Number.isFinite(n) && n > 0 ? clamp(n) : SIDEBAR_DEFAULT;
	} catch {
		return SIDEBAR_DEFAULT;
	}
}

/** Desktop sidebar width in px, persisted; `handleProps` goes on the drag handle. */
export function useSidebarWidth() {
	const [width, setWidth] = useState(load);
	const [dragging, setDragging] = useState(false);
	const latest = useRef(width);
	latest.current = width;
	const drag = useRef<{ x: number; w: number } | null>(null);

	const onPointerDown = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag.current = { x: e.clientX, w: latest.current };
		setDragging(true);
	}, []);
	const onPointerMove = useCallback((e: React.PointerEvent) => {
		if (drag.current) setWidth(clamp(drag.current.w + e.clientX - drag.current.x));
	}, []);
	const end = useCallback(() => {
		if (!drag.current) return;
		drag.current = null;
		setDragging(false);
		try {
			localStorage.setItem(KEY, String(latest.current));
		} catch {}
	}, []);
	const reset = useCallback(() => {
		setWidth(SIDEBAR_DEFAULT);
		try {
			localStorage.removeItem(KEY);
		} catch {}
	}, []);
	const onKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		const next = clamp(latest.current + (e.key === "ArrowRight" ? 16 : -16));
		setWidth(next);
		try {
			localStorage.setItem(KEY, String(next));
		} catch {}
	}, []);

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
		handleProps: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onDoubleClick: reset, onKeyDown },
	};
}
