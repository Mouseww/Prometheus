/**
 * The relay and the tool bus listen on 127.0.0.1. A child CLI that inherits HTTP(S)_PROXY would send those
 * requests through the proxy, which cannot reach this machine's loopback, so loopback is always exempted.
 */
export function withLoopbackNoProxy<T extends Record<string, string | undefined>>(env: T): T {
	const merge = (current: string | undefined): string => [...new Set([...(current ?? "").split(",").map((s) => s.trim()).filter(Boolean), "127.0.0.1", "localhost", "::1"])].join(",");
	return { ...env, NO_PROXY: merge(env.NO_PROXY ?? env.no_proxy), no_proxy: merge(env.no_proxy ?? env.NO_PROXY) };
}
