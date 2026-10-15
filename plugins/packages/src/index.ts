import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { definePlugin } from "@prometheus/plugin-sdk";
import type { PackageInfo, PackageJob, PackageSearchPage, PackageUpdateInfo } from "@prometheus/protocol";
import { captureCommandOutput } from "./capture.ts";
import { explainFailure } from "./explain.ts";
import { JobTracker } from "./jobs.ts";
import { readManifest } from "./manifest.ts";
import { parseSearch, resolveRegistry, searchUrl } from "./registry.ts";
import { normalizeSource, npmNameOf } from "./source.ts";

const SEARCH_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 24;

function fallbackName(source: string): string {
	return npmNameOf(source) ?? source.replace(/^git:/, "").replace(/^https:\/\//, "").replace(/@[^/@]+$/, "");
}

export default definePlugin({
	name: "packages",
	version: "0.1.0",
	setup(ctx) {
		const registry = resolveRegistry(ctx.settings.registry);
		const settings = SettingsManager.create(ctx.cwd, ctx.agentDir);
		const manager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir: ctx.agentDir, settingsManager: settings });

		// npm/git operations rewrite settings.json and node_modules, so they run one at a time in the background.
		const jobs = new JobTracker(explainFailure);
		if (!captureCommandOutput(manager, (chunk) => jobs.append(chunk))) ctx.log.warn("无法捕获 npm 输出，安装失败时只能显示退出码");

		const list = async (): Promise<PackageInfo[]> => {
			await settings.reload();
			return manager.listConfiguredPackages().map((p) => {
				const manifest = p.installedPath ? readManifest(p.installedPath) : undefined;
				return {
					source: p.source,
					scope: p.scope,
					name: manifest?.name ?? fallbackName(p.source),
					version: manifest?.version,
					description: manifest?.description,
					kinds: manifest?.kinds ?? [],
					installed: Boolean(p.installedPath),
					filtered: p.filtered,
				};
			});
		};

		const apply = async () => {
			await settings.flush();
			await ctx.reloadSessions();
		};

		ctx.rpc("list", list);

		ctx.rpc("search", async (params): Promise<PackageSearchPage> => {
			const query = typeof params.query === "string" ? params.query : "";
			const page = Math.max(0, Math.min(Number.isInteger(params.page) ? (params.page as number) : 0, 500));
			let res: Response;
			try {
				res = await fetch(searchUrl(registry, query, page, PAGE_SIZE), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS), headers: { accept: "application/json" } });
			} catch (err) {
				throw new Error(`无法连接插件市场：${err instanceof Error ? err.message : err}`);
			}
			if (!res.ok) throw new Error(`插件市场返回 ${res.status}`);
			return parseSearch(await res.json(), page, PAGE_SIZE);
		});

		ctx.rpc("install", (params): PackageJob => {
			const source = normalizeSource(params.source);
			return jobs.run("install", source, typeof params.label === "string" && params.label ? params.label.slice(0, 120) : fallbackName(source), async () => {
				await settings.reload();
				await manager.installAndPersist(source);
				await apply();
			});
		});

		ctx.rpc("remove", (params): PackageJob => {
			if (typeof params.source !== "string") throw new Error("缺少 source");
			const source = params.source;
			return jobs.run("remove", source, fallbackName(source), async () => {
				await settings.reload();
				const configured = manager.listConfiguredPackages().find((p) => p.scope === "user" && p.source === source);
				if (!configured) throw new Error("该包不在已安装列表中");
				await manager.removeAndPersist(configured.source);
				await apply();
			});
		});

		ctx.rpc("update", (params): PackageJob => {
			const source = typeof params.source === "string" ? params.source : undefined;
			return jobs.run("update", source ?? "*", source ? fallbackName(source) : "*", async () => {
				await settings.reload();
				if (source && !manager.listConfiguredPackages().some((p) => p.source === source)) throw new Error("该包不在已安装列表中");
				await manager.update(source);
				await apply();
			});
		});

		ctx.rpc("jobs", (): PackageJob[] => jobs.list());

		ctx.rpc("dismiss", (params) => {
			if (typeof params.id === "string") jobs.dismiss(params.id);
			return null;
		});

		ctx.rpc("checkUpdates", async (): Promise<PackageUpdateInfo[]> => {
			await settings.reload();
			const updates = await manager.checkForAvailableUpdates();
			return updates.map((u) => ({ source: u.source, name: u.displayName, scope: u.scope, type: u.type }));
		});
	},
});
