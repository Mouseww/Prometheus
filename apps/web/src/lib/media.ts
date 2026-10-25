/** Subscribes to a MediaQueryList; old WebViews (macOS 10.15) only have the deprecated addListener. */
export function onMediaChange(query: MediaQueryList, listener: () => void): () => void {
	if (typeof query.addEventListener === "function") {
		query.addEventListener("change", listener);
		return () => query.removeEventListener("change", listener);
	}
	query.addListener(listener);
	return () => query.removeListener(listener);
}
