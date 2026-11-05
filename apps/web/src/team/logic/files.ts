// Small helpers for the snapshot file browser.

/** Repository-relative child path: `joinPath("src", "a.ts")` is `src/a.ts`, `joinPath("", "a.ts")` is `a.ts`. */
export function joinPath(dir: string, name: string): string {
	return dir ? `${dir.replace(/\/+$/, "")}/${name}` : name;
}

/** Breadcrumb entries of a path: `a/b` gives `[{name:"a",path:"a"},{name:"b",path:"a/b"}]`. */
export function parentPaths(path: string): { name: string; path: string }[] {
	const parts = path.split("/").filter(Boolean);
	return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

/** UTF-8 text of base64 content; invalid base64 yields an empty string. */
export function decodeBase64Text(b64: string): string {
	try {
		const bin = atob(b64);
		const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
		return new TextDecoder("utf-8").decode(bytes);
	} catch {
		return "";
	}
}
