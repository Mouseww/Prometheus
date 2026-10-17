/** `1.2.3` is newer than `1.2.0`; a leading `v` is ignored and non-numeric parts count as 0. */
export function isNewer(candidate: string, current: string): boolean {
	const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	const a = parts(candidate);
	const b = parts(current);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}
