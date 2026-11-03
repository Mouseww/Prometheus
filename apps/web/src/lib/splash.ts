/**
 * The ignition splash lives in index.html so it paints before the bundle loads. The app calls
 * `dismissSplash()` once it has something to show; the splash then plays out its minimum length
 * (so the ignition never cuts off mid-flame) and hands over with the app rising in underneath.
 */

/** Just long enough for the flame to catch; it used to be 1500 ms, which made every start feel slow even when the app was ready at once. */
const MIN_MS = 500;
const OUT_MS = 520;

let dismissed = false;

export function dismissSplash(): void {
	if (dismissed) return;
	dismissed = true;
	const el = document.getElementById("splash");
	if (!el) return;
	const still = el.classList.contains("sp-still");
	const t0 = (window as { __splashT0?: number }).__splashT0 ?? 0;
	const wait = still ? 0 : Math.max(0, MIN_MS - (performance.now() - t0));
	window.setTimeout(() => {
		const root = document.documentElement;
		root.style.removeProperty("background");
		if (!still) root.dataset.entering = "";
		el.classList.add("sp-out");
		window.setTimeout(() => {
			el.remove();
			delete root.dataset.entering;
		}, OUT_MS + 300);
	}, wait);
}
