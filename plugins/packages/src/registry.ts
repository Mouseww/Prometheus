import type { PackageListing, PackageSearchPage } from "@prometheus/protocol";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** PI's gallery convention: npm packages carrying this keyword are discoverable. */
export const PACKAGE_KEYWORD = "pi-package";
const MAX_QUERY = 100;

export function resolveRegistry(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return DEFAULT_REGISTRY;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("pluginSettings.packages.registry 不是合法地址");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("registry 必须是 http(s) 地址");
	return url.toString().replace(/\/+$/, "");
}

export function searchUrl(registry: string, query: string, page: number, size: number): string {
	const text = `keywords:${PACKAGE_KEYWORD} ${query.trim().slice(0, MAX_QUERY)}`.trim();
	const params = new URLSearchParams({ text, size: String(size), from: String(page * size) });
	return `${registry}/-/v1/search?${params}`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Defensive parse: the registry is a remote, untrusted source. */
export function parseSearch(json: unknown, page: number, size: number): PackageSearchPage {
	const root = (json && typeof json === "object" ? json : {}) as { total?: unknown; objects?: unknown };
	const objects = Array.isArray(root.objects) ? root.objects : [];
	const items: PackageListing[] = [];
	for (const entry of objects) {
		const pkg = (entry as { package?: Record<string, unknown> } | null)?.package;
		const name = str(pkg?.name);
		const version = str(pkg?.version);
		if (!pkg || !name || !version) continue;
		const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.filter((k): k is string => typeof k === "string") : [];
		if (!keywords.includes(PACKAGE_KEYWORD)) continue;
		const links = (pkg.links && typeof pkg.links === "object" ? pkg.links : {}) as Record<string, unknown>;
		const author = (pkg.author as { name?: unknown } | undefined)?.name ?? (pkg.publisher as { username?: unknown } | undefined)?.username;
		items.push({
			name,
			version,
			description: str(pkg.description)?.slice(0, 500),
			author: str(author),
			date: str(pkg.date),
			keywords: keywords.filter((k) => k !== PACKAGE_KEYWORD).slice(0, 8),
			source: `npm:${name}`,
			links: { npm: str(links.npm), homepage: str(links.homepage), repository: str(links.repository) },
		});
	}
	return { total: typeof root.total === "number" ? root.total : items.length, items, page, size };
}
