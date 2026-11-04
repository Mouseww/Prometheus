// Settings → About: versions, the source, and the one place in the app that asks for a GitHub star.
//
// The star count comes from a single request made when this page opens (see lib/star.ts): no polling, no cached
// number, and with no network it degrades to just the link. The page is reached on purpose, which is why it is the
// right place to ask — unlike a startup popup, nobody is interrupted by it.
import { ArrowUpRight, Check, Copy, Star } from "lucide-react";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { copyToClipboard } from "../lib/clipboard.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { openExternal } from "../lib/links.ts";
import { loadStars, REPO, REPO_URL, starsText, useStar } from "../lib/star.ts";
import { useStore } from "../lib/store.ts";
import { Badge, Button, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "关于",
		subtitle: "版本、开源仓库",
		version: "当前版本",
		serverVersion: "服务端版本",
		mismatch: "与服务端不一致",
		piVersion: "PI 版本",
		copyVersion: "复制版本信息",
		diagnostics: "排查问题",
		copied: "已复制",
		repo: "开源仓库",
		license: "许可证",
		openSource: "Prometheus 是开源项目（AGPL-3.0）：可以自己部署、修改、再分发。",
		starCta: "给它一颗 Star",
		starred: "已经 Star 了",
		starHint: "它如果帮上了忙，Star 是最实在的支持方式——能让还在找这类工具的人看到它。",
		starHintDone: "谢谢！每一颗 Star 都会帮到下一个找工具的人。",
		starCount: "{n} 个 Star",
		open: "在 GitHub 打开",
		markStarred: "我已 Star",
	},
	en: {
		title: "About",
		subtitle: "Versions and source",
		version: "Version",
		serverVersion: "Server version",
		mismatch: "Differs from the server",
		piVersion: "PI version",
		copyVersion: "Copy version info",
		diagnostics: "Troubleshooting",
		copied: "Copied",
		repo: "Repository",
		license: "License",
		openSource: "Prometheus is open source (AGPL-3.0): self-host it, change it, pass it on.",
		starCta: "Give it a star",
		starred: "Starred",
		starHint: "If it helped, a star is the most useful way to say thanks — it helps the next person find it.",
		starHintDone: "Thank you! Every star helps the next person looking for a tool like this.",
		starCount: "{n} stars",
		open: "Open on GitHub",
		markStarred: "I've starred it",
	},
});

export function AboutView() {
	const t = useT(M);
	const info = useStore((s) => s.hostInfo);
	const stars = useStar((s) => s.stars);
	const [starred, setStarred] = useState(false);

	const client = __APP_VERSION__;
	const server = info?.version;
	const differs = Boolean(server) && server !== client;
	const summary = `Prometheus ${client}${server ? ` (server ${server}, PI ${info?.piVersion})` : ""} · ${info?.platform ?? navigator.platform}`;

	// One request for the count, on open. Nothing is polled and nothing is cached, so a stale number never shows.
	useEffect(() => {
		void loadStars();
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4 @3xl:p-8">
				<div className="mx-auto max-w-2xl space-y-6">
					{/* The ask: at the top, because it is what this page is for besides the numbers, and only here. */}
					<section className="rounded-xl border border-ember-500/25 bg-ember-500/[0.05] p-4">
						<div className="flex items-start gap-3">
							<span className="grid size-9 shrink-0 place-items-center rounded-lg bg-ember-500/12 text-ember-300">
								<Star className={clsx("size-4", starred && "fill-current")} />
							</span>
							<div className="min-w-0 flex-1">
								<h2 className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-100">
									{starred ? t("starred") : t("starCta")}
									{typeof stars === "number" && <Badge>{t("starCount", { n: starsText(stars) })}</Badge>}
								</h2>
								<p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">{starred ? t("starHintDone") : t("starHint")}</p>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<Button variant="primary" onClick={() => void openExternal(REPO_URL)}>
										{t("open")}
										<ArrowUpRight className="size-3.5 opacity-70" />
									</Button>
									{!starred && (
										<Button variant="ghost" onClick={() => setStarred(true)}>
											<Check className="size-4" /> {t("markStarred")}
										</Button>
									)}
								</div>
							</div>
						</div>
					</section>

					{/* One compact table, like the rows on the General tab: label left, value right. */}
					<dl className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800 bg-ink-900/60 text-[13px]">
						<Row label={t("version")}>
							<span className="font-mono text-ink-100">v{client}</span>
						</Row>
						<Row label={t("serverVersion")} note={differs ? t("mismatch") : undefined}>
							<span className={`font-mono ${differs ? "text-ember-300" : "text-ink-100"}`}>{server ? `v${server}` : "—"}</span>
						</Row>
						<Row label={t("piVersion")}>
							<span className="font-mono text-ink-100">{info?.piVersion ? `v${info.piVersion}` : "—"}</span>
						</Row>
						<Row label={t("license")}>
							<span className="text-ink-100">AGPL-3.0</span>
						</Row>
						<Row label={t("repo")}>
							<button type="button" onClick={() => void openExternal(REPO_URL)} className="flex min-w-0 items-center gap-1.5 font-mono text-ink-100 underline decoration-dotted underline-offset-4 hover:text-ember-300">
								<span className="truncate">{REPO}</span>
								<ArrowUpRight className="size-3.5 shrink-0 text-ink-600" />
							</button>
						</Row>
						<Row label={t("diagnostics")}>
							<Button variant="ghost" onClick={() => void copyToClipboard(summary).then(() => undefined)}>
								<Copy className="size-3.5" /> {t("copyVersion")}
							</Button>
						</Row>
					</dl>
					<p className="text-[12px] leading-relaxed text-ink-500">{t("openSource")}</p>
				</div>
			</div>
		</div>
	);
}

/** One line of the About table: a quiet label, then whatever the row shows, pushed right. */
function Row({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3 px-4 py-2.5">
			<dt className="shrink-0 text-ink-500">{label}</dt>
			{note && <span className="shrink-0 text-[11px] text-ember-400">{note}</span>}
			<dd className="ml-auto flex min-w-0 justify-end">{children}</dd>
		</div>
	);
}
