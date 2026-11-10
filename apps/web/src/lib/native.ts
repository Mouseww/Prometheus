/**
 * Bridge the Android shell injects into the WebView (see `MainActivity` in
 * apps/desktop/scripts/android-runtime.ts). It lets the page tell the system bars how to look, which the
 * shell cannot work out on its own: the app theme is a user preference, unrelated to the phone's dark mode.
 */
interface AndroidHost {
	/** True for a dark app theme (light bar icons); false for a light one (dark bar icons). */
	theme?: (dark: boolean) => void;
	/** Saves a download link into the phone's Downloads folder via DownloadManager. */
	download?: (url: string, name: string) => void;
	/** Status bar height in CSS px (the WebView reports 0 for safe-area-inset-top without a cutout). */
	safeTop?: () => number;
}

declare global {
	interface Window {
		PrometheusHost?: AndroidHost;
		/**
		 * The other direction: the shell asks the page what a back gesture should close (lib/back.ts answers, and
		 * `false` means the shell backgrounds the app).
		 */
		PrometheusBack?: () => boolean;
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
