/**
 * Upstream URL = gateway base URL + request path. Clients configure `<hub>/llm/openai/v1` while an admin stores
 * `https://api.openai.com/v1`: segments that end the base and start the request path are not repeated.
 */
export function joinUpstreamUrl(baseUrl: string, restPath: string, query?: URLSearchParams): string {
	const base = new URL(baseUrl);
	const baseSegments = base.pathname.split("/").filter(Boolean);
	const rest = restPath.split("/").filter(Boolean);
	let overlap = Math.min(baseSegments.length, rest.length);
	while (overlap > 0 && !baseSegments.slice(-overlap).every((s, i) => s === rest[i])) overlap--;
	const path = [...baseSegments, ...rest.slice(overlap)].join("/");
	const search = query && [...query.keys()].length > 0 ? `?${query.toString()}` : "";
	return `${base.origin}/${path}${search}`;
}

/** True when a raw (still percent-encoded) path has a `.` or `..` segment, which could climb out of the gateway's base path. */
export function hasDotSegment(rawPath: string): boolean {
	return rawPath.split("/").some((s) => {
		let decoded = s;
		try {
			decoded = decodeURIComponent(s);
		} catch {
			return true;
		}
		return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
	});
}
