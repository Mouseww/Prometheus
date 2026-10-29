import { flushSync } from "react-dom";
import { setPrefs, usePrefs, type Skin, type ThemeMode } from "./prefs.ts";

// Segmented controls report only the chosen value, so the reveal starts from the last place the user pressed.
let lastPress: { clientX: number; clientY: number } | undefined;
window.addEventListener("pointerdown", (e) => (lastPress = { clientX: e.clientX, clientY: e.clientY }), { capture: true, passive: true });

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => void) => { ready: Promise<void> } };

/**
 * Changes theme or skin with a circular reveal spreading from the click point (View Transitions API).
 * Engines without the API, or the motion switch turned off, just switch instantly.
 */
export function switchLook(patch: { theme?: ThemeMode; skin?: Skin }, from?: { clientX: number; clientY: number }): void {
	const doc = document as ViewTransitionDoc;
	const still = !usePrefs.getState().motion;
	if (!doc.startViewTransition || still) return setPrefs(patch);
	const at = from ?? lastPress;
	const x = at?.clientX ?? window.innerWidth / 2;
	const y = at?.clientY ?? window.innerHeight / 2;
	const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
	const vt = doc.startViewTransition(() => flushSync(() => setPrefs(patch)));
	vt.ready
		.then(() => {
			document.documentElement.animate(
				{ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
				{ duration: 560, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
			);
		})
		.catch(() => undefined);
}
