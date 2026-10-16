import { useSyncExternalStore } from "react";

/** Matches Tailwind's `max-md`: below this width the sidebar becomes a drawer and pages go full screen. */
const MOBILE = "(max-width: 767px)";

const subscribe = (notify: () => void) => {
	const query = window.matchMedia(MOBILE);
	query.addEventListener("change", notify);
	return () => query.removeEventListener("change", notify);
};

export const useIsMobile = (): boolean =>
	useSyncExternalStore(
		subscribe,
		() => window.matchMedia(MOBILE).matches,
		() => false,
	);
