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
