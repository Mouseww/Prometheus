import { useEffect, useRef } from "react";

/**
 * The system back gesture, as Android hands it to the page through `window.PrometheusBack` (see `installBackHandler`
 * and the MainActivity patch in apps/desktop/scripts/android-runtime.ts).
 *
 * Without it the shell had nothing to ask, so back left the app from anywhere — including a full-screen composer the
 * user only wanted to close. Layers that can be closed register themselves here and the topmost one gets the gesture;
 * when none wants it, the shell sends the app to the background instead of finishing it.
 */

/** Close order for the gesture. A layer drawn higher up must win. */
export const BACK_LAYER = { sheet: 40, view: 30, drawer: 20 } as const;

type Layer = { priority: number; close: () => void };

const layers: Layer[] = [];

/** Registers `close` while `active`. The latest callback is always the one called, so it may be a fresh closure. */
export function useBackLayer(priority: number, active: boolean, close: () => void): void {
	const latest = useRef(close);
	latest.current = close;
	useEffect(() => {
		if (!active) return;
		const layer: Layer = { priority, close: () => latest.current() };
		layers.push(layer);
		return () => {
			const at = layers.indexOf(layer);
			if (at >= 0) layers.splice(at, 1);
		};
	}, [priority, active]);
}

/**
 * True when the gesture was used up. Blocking dialogs answer to Escape and own no state we can reach from here, so
 * they are closed by replaying the key; everything else must register above.
 */
export function handleBack(): boolean {
	let top: Layer | undefined;
	for (const layer of layers) if (!top || layer.priority >= top.priority) top = layer;
	if (top) {
		top.close();
		return true;
	}
	if (document.querySelector('[aria-modal="true"]')) {
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		return true;
	}
	return false;
}

/** Must run before the shell can ask; a page that never installs it simply keeps the shell's old behaviour. */
export function installBackHandler(): void {
	window.PrometheusBack = handleBack;
}
