/**
 * Bridge the Android shell injects into the WebView (see `MainActivity` in
 * apps/desktop/scripts/android-runtime.ts). It lets the page tell the system bars how to look, which the
 * shell cannot work out on its own: the app theme is a user preference, unrelated to the phone's dark mode.
 */
interface AndroidHost {
	/** True for a dark app theme (light bar icons); false for a light one (dark bar icons). */
	theme?: (dark: boolean) => void;
}

declare global {
	interface Window {
		PrometheusHost?: AndroidHost;
	}
}

/** No-op on the desktop shell and in browsers. */
export function syncNativeTheme(dark: boolean): void {
	try {
		window.PrometheusHost?.theme?.(dark);
	} catch {
		// A refused call means the bridge is missing or changed; the UI has to keep working either way.
	}
}
