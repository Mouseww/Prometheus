import { useEffect, useState, useSyncExternalStore } from "react";
import { onMediaChange } from "./media.ts";

/** Matches Tailwind's `max-md`: below this width the sidebar becomes a drawer and pages go full screen. */
const MOBILE = "(max-width: 767px)";

const subscribe = (notify: () => void) => {
	const query = window.matchMedia(MOBILE);
	return onMediaChange(query, notify);
};

export const useIsMobile = (): boolean =>
	useSyncExternalStore(
		subscribe,
		() => window.matchMedia(MOBILE).matches,
		() => false,
	);

/**
 * The part of the page that is actually visible, in the coordinates a `position: fixed` layer uses.
 *
 * On a phone the on-screen keyboard shrinks the visual viewport but, since the default `interactive-widget` is
 * `resizes-visual`, leaves the layout viewport — and therefore anything sized with `inset-0` — at full height. A
 * fixed layer then reaches under the keyboard, which is where the bottom of a full-screen composer went.
 */
export function useVisualViewport(): { top: number; height: number } {
	const read = () => {
		const vv = window.visualViewport;
		return { top: Math.round(vv?.offsetTop ?? 0), height: Math.round(vv?.height ?? window.innerHeight) };
	};
	const [box, setBox] = useState(read);

	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		let frame = 0;
		// Resize and scroll both fire while the keyboard animates; one measurement per frame is enough.
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const next = { top: Math.round(vv.offsetTop), height: Math.round(vv.height) };
				setBox((prev) => (prev.top === next.top && prev.height === next.height ? prev : next));
			});
		};
		update();
		vv.addEventListener("resize", update);
		vv.addEventListener("scroll", update);
		return () => {
			cancelAnimationFrame(frame);
			vv.removeEventListener("resize", update);
			vv.removeEventListener("scroll", update);
		};
	}, []);

	return box;
}

/**
 * Keeps the whole app above the on-screen keyboard. When the keyboard shrinks only the visual viewport, `#root` is
 * sized to it (and moved with it on iOS, which scrolls the page), so the focused input is never covered.
 */
export function installKeyboardInset(): void {
	const vv = window.visualViewport;
	if (!vv) return;
	const root = document.documentElement;
	let frame = 0;
	const apply = () => {
		frame = 0;
		const covered = window.innerHeight - vv.height - vv.offsetTop;
		if (window.matchMedia(MOBILE).matches && window.innerHeight - vv.height > 100) {
			root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
			root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
			if (covered > -1) window.scrollTo(0, 0);
		} else {
			root.style.removeProperty("--app-h");
			root.style.removeProperty("--app-top");
		}
	};
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(apply);
	};
	vv.addEventListener("resize", schedule);
	vv.addEventListener("scroll", schedule);
	apply();
}

/**
 * Android WebView reports `safe-area-inset-top` as 0 unless there is a cutout, so the status bar covers the top bar.
 * The shell knows the real height (CSS px); publish it as `--safe-top`.
 */
export function installSafeArea(): void {
	const root = document.documentElement;
	const apply = () => {
		let top = 0;
		try {
			top = Math.round(window.PrometheusHost?.safeTop?.() ?? 0);
		} catch {
			top = 0;
		}
		if (top > 0) root.style.setProperty("--safe-top", `${top}px`);
		else root.style.removeProperty("--safe-top");
	};
	apply();
	for (const ms of [150, 600, 1500]) setTimeout(apply, ms); // the bridge may be injected after this module loads
	window.addEventListener("resize", apply);
	window.addEventListener("orientationchange", apply);
}
