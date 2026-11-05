// The team plugin's RPC results are not typed on the web side; these helpers read the few fields the UI needs defensively.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Unwraps a `{ok:true,data}` envelope when the plugin returns one. */
function payload(result: unknown): unknown {
	return isRecord(result) && typeof result.ok === "boolean" && "data" in result ? result.data : result;
}

/** The local Prometheus session id from `session.start` / `session.fork` (a bare id string or an object carrying it). */
export function localSessionIdOf(result: unknown): string | undefined {
	const data = payload(result);
	if (typeof data === "string" && data !== "") return data;
	if (!isRecord(data)) return undefined;
	for (const key of ["localSessionId", "sessionId", "id"]) {
		const v = data[key];
		if (typeof v === "string" && v !== "") return v;
	}
	return undefined;
}
