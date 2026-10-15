import { Blocks, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { PluginInfo } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { call } from "../lib/store.ts";
import { Badge, Empty, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "Prometheus 插件",
		subtitle: "扩展本项目自身：网关、知识库、工具、命令、面板。PI 扩展包请到“PI 插件市场”安装",
		empty: "没有已加载的插件",
		panels: "面板：{list}",
		listSep: "、",
		write: "编写插件",
		placeIn: "放入",
		declareIn: "（含 package.json），或在 config.json 的",
		declareTail: "中声明 npm 包名。同一插件在 TUI 与 GUI 中行为一致。重启后生效。",
		trust: "插件以宿主进程权限运行，请只安装可信来源的插件。",
	},
	en: {
		title: "Prometheus Plugins",
		subtitle: "Extend this app itself: gateways, knowledge, tools, commands, panels. For PI packages, use the PI Marketplace",
		empty: "No plugins loaded",
		panels: "Panels: {list}",
		listSep: ", ",
		write: "Writing plugins",
		placeIn: "Put it in",
		declareIn: "(with a package.json), or declare the npm package name in",
		declareTail: "of config.json. A plugin behaves the same in the TUI and GUI. Takes effect after restart.",
		trust: "Plugins run with host process permissions. Only install plugins from trusted sources.",
	},
});

const SNIPPET = `import { definePlugin } from "@prometheus/plugin-sdk";
import { Type } from "@earendil-works/pi-ai";

export default definePlugin({
  name: "hello",
  setup(ctx) {
    ctx.extension((pi) => {
      pi.registerTool({
        name: "greet",
        label: "打招呼",
        description: "Greet someone by name",
        parameters: Type.Object({ name: Type.String() }),
        async execute(_id, { name }) {
          return { content: [{ type: "text", text: \`你好，\${name}!\` }], details: {} };
        },
      });
    });
  },
});`;

export function PluginsView() {
	const t = useT(M);
	const [plugins, setPlugins] = useState<PluginInfo[]>([]);
	useEffect(() => {
		void call((c) => c.rpc("plugin.list", {})).then((p) => p && setPlugins(p));
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 overflow-y-auto p-6">
				<div className="mx-auto max-w-4xl space-y-8">
					{plugins.length === 0 ? (
						<Empty icon={<Blocks className="size-5" />} title={t("empty")} />
					) : (
						<div className="grid gap-3 md:grid-cols-2">
							{plugins.map((p) => (
								<div key={`${p.source}:${p.name}`} className="animate-rise rounded-xl border border-ink-800 bg-ink-900/60 p-4">
									<div className="flex items-center gap-2">
										<span className={`size-2 rounded-full ${p.status === "loaded" ? "bg-moss-400" : "bg-rose-400"}`} />
										<span className="font-mono text-sm font-medium">{p.name}</span>
										{p.version && <span className="font-mono text-[11px] text-ink-500">v{p.version}</span>}
										<span className="ml-auto">
											<Badge tone={p.source === "builtin" ? "muted" : "ember"}>{p.source}</Badge>
										</span>
									</div>
									{p.error && (
										<p className="mt-2 flex items-start gap-1.5 text-xs text-rose-400">
											<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
											{p.error}
										</p>
									)}
									{p.panels.length > 0 && <p className="mt-2 text-xs text-ink-500">{t("panels", { list: p.panels.map((x) => x.title).join(t("listSep")) })}</p>}
								</div>
							))}
						</div>
					)}

					<section className="rounded-2xl border border-ink-800 bg-ink-900/40 p-6">
						<h3 className="font-display text-lg font-semibold">{t("write")}</h3>
						<p className="mt-1 text-sm text-ink-400">
							{t("placeIn")} <code className="font-mono text-ember-200">~/.prometheus/plugins/&lt;name&gt;/</code> {t("declareIn")} <code className="font-mono text-ember-200">plugins</code>{" "}
							{t("declareTail")}
						</p>
						<pre className="mt-4 overflow-x-auto rounded-xl border border-ink-800 bg-ink-950 p-4 font-mono text-xs leading-relaxed text-ink-300">{SNIPPET}</pre>
						<p className="mt-3 text-xs text-ink-500">{t("trust")}</p>
					</section>
				</div>
			</div>
		</div>
	);
}
