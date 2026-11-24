import type { SessionSummary, SyncReport, SyncScope } from "@prometheus/protocol";
import { ArrowDownToLine, ArrowUpFromLine, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { loadPlatforms, samePlatform } from "../lib/platforms.ts";
import { setPrefs, usePrefs } from "../lib/prefs.ts";
import { refreshSessions, useStore } from "../lib/store.ts";
import { listSourceSessions, openPeer, runSync, type SyncDirection } from "../lib/sync.ts";
import { Button, Field, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "平台同步",
		intro: "在当前连接的平台与另一个已保存的平台之间复制内容。只复制、不删除；每一项都是可选的。",
		peer: "对方平台",
		noPeer: "先在上方添加另一个平台",
		pull: "拉取：对方 → 当前",
		push: "推送：当前 → 对方",
		direction: "方向",
		scopes: "同步内容",
		gateways: "AI 网关（含密钥）",
		settings: "后台设置",
		projects: "项目（仅本机存在的目录）",
		sessions: "会话",
		overwrite: "同名网关以来源为准（关闭则保留目标已有的）",
		pickSessions: "选择会话",
		loading: "读取中…",
		sessionsHint: "未手动选择时，手动同步最近的 20 个会话。每个会话只会复制一次，复制后是一份新的对话，可继续聊；目录不存在时放进默认目录。",
		selected: "已选 {n} 个",
		syncNow: "立即同步",
		syncing: "同步中…",
		auto: "自动同步（需主动开启）",
		autoHint: "仅在本应用打开并已连接时运行；会话只同步上次之后有改动的，每次最多 20 个。",
		every: "间隔",
		minutes: "{n} 分钟",
		result: "网关 +{ga} 更新 {gu}，设置 {st}，项目 +{pa}，会话 +{sa}，跳过 {sk}",
		on: "已同步",
		off: "未同步",
		failed: "同步失败：{msg}",
		secrets: "网关密钥会明文传给对方平台，请只同步你信任的平台。",
	},
	en: {
		title: "Platform sync",
		intro: "Copy things between the platform you are connected to and another saved platform. Copy only, nothing is deleted; every part is optional.",
		peer: "Other platform",
		noPeer: "Add another platform above first",
		pull: "Pull: other → this",
		push: "Push: this → other",
		direction: "Direction",
		scopes: "What to sync",
		gateways: "AI gateways (with keys)",
		settings: "Backend settings",
		projects: "Projects (folders that exist here)",
		sessions: "Chats",
		overwrite: "Source wins for gateways with the same id (off keeps the target's)",
		pickSessions: "Choose chats",
		loading: "Loading…",
		sessionsHint: "Without a manual choice, a manual sync takes the 20 most recent chats. Each chat is copied once, as a new conversation you can continue; if its folder is missing it goes to the default one.",
		selected: "{n} selected",
		syncNow: "Sync now",
		syncing: "Syncing…",
		auto: "Automatic sync (opt-in)",
		autoHint: "Runs only while this app is open and connected; chats changed since the last run, at most 20 each time.",
		every: "Every",
		minutes: "{n} min",
		result: "Gateways +{ga} updated {gu}, settings {st}, projects +{pa}, chats +{sa}, skipped {sk}",
		on: "synced",
		off: "not synced",
		failed: "Sync failed: {msg}",
		secrets: "Gateway keys are sent to the other platform in clear; only sync platforms you trust.",
	},
});

const SCOPES: SyncScope[] = ["gateways", "settings", "projects", "sessions"];
const INTERVALS = [5, 15, 30, 60, 180, 720];

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function PlatformSync() {
	const t = useT(M);
	const client = useStore((s) => s.client);
	const prefs = usePrefs((s) => s.sync);
	const [peers] = useState(() => loadPlatforms());
	const currentUrl = client?.target.httpBase ?? "";
	const candidates = peers.filter((p) => !samePlatform(p.url, currentUrl));
	const peer = candidates.find((p) => p.id === prefs.peerId) ?? candidates[0];
	const [busy, setBusy] = useState(false);
	const [picking, setPicking] = useState(false);
	const [list, setList] = useState<SessionSummary[] | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [msg, setMsg] = useState("");

	const set = (patch: Partial<typeof prefs>) => setPrefs({ sync: { ...prefs, ...patch, ...(peer && !patch.peerId ? { peerId: peer.id } : {}) } });
	const toggleScope = (s: SyncScope) => set({ scopes: prefs.scopes.includes(s) ? prefs.scopes.filter((x) => x !== s) : [...prefs.scopes, s] });
	const withSessions = prefs.scopes.includes("sessions");
	const resetPick = () => {
		setPicking(false);
		setList(null);
		setChosen(new Set());
	};

	const loadList = async () => {
		if (!client || !peer) return;
		setPicking(true);
		setList(null);
		try {
			const source = prefs.direction === "pull" ? await openPeer(peer) : client;
			try {
				setList(await listSourceSessions(source));
			} finally {
				if (source !== client) source.close();
			}
		} catch (err) {
			setMsg(t("failed", { msg: errText(err) }));
			setPicking(false);
		}
	};

	const run = async () => {
		if (!client || !peer || !prefs.scopes.length) return;
		setBusy(true);
		setMsg("");
		try {
			const r: SyncReport = await runSync(client, {
				peer,
				direction: prefs.direction,
				scopes: prefs.scopes,
				overwrite: prefs.overwrite,
				...(withSessions && picking && list ? { sessionIds: [...chosen] } : { since: 0 }),
			});
			const skipped = r.gateways.skipped.length + r.projects.skipped.length + r.sessions.skipped.length;
			setMsg(t("result", { ga: r.gateways.added, gu: r.gateways.updated, st: r.settings ? t("on") : t("off"), pa: r.projects.added, sa: r.sessions.added, sk: skipped }));
			if (prefs.direction === "pull") void refreshSessions();
		} catch (err) {
			setMsg(t("failed", { msg: errText(err) }));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
			<div>
				<h3 className="font-display font-semibold">{t("title")}</h3>
				<p className="mt-1 text-xs text-ink-500">{t("intro")}</p>
			</div>
			{!peer ? (
				<p className="text-sm text-ink-400">{t("noPeer")}</p>
			) : (
				<>
					<div className="grid gap-3 @xl:grid-cols-2">
						<Field label={t("peer")}>
							<Select value={peer.id} onChange={(e) => set({ peerId: e.target.value })}>
								{candidates.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</Select>
						</Field>
						<Field label={t("direction")}>
							<Select
								value={prefs.direction}
								onChange={(e) => {
									set({ direction: e.target.value as SyncDirection });
									resetPick();
								}}
							>
								<option value="pull">{t("pull")}</option>
								<option value="push">{t("push")}</option>
							</Select>
						</Field>
					</div>
					<Field label={t("scopes")}>
						<div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-ink-300">
							{SCOPES.map((s) => (
								<label key={s} className="flex items-center gap-1.5">
									<input type="checkbox" checked={prefs.scopes.includes(s)} onChange={() => toggleScope(s)} />
									{t(s)}
								</label>
							))}
						</div>
					</Field>
					<label className="flex items-center gap-2 text-sm text-ink-300">
						<input type="checkbox" checked={prefs.overwrite} onChange={(e) => set({ overwrite: e.target.checked })} />
						{t("overwrite")}
					</label>
					{withSessions && (
						<div className="space-y-2 rounded-lg border border-ink-800 p-3">
							<div className="flex items-center gap-3">
								<Button variant="outline" onClick={() => void loadList()}>
									{t("pickSessions")}
								</Button>
								{picking && <span className="text-xs text-ink-500">{list ? t("selected", { n: chosen.size }) : t("loading")}</span>}
							</div>
							{list && (
								<div className="max-h-52 space-y-1 overflow-y-auto text-sm">
									{list.map((s) => (
										<label key={s.id} className="flex items-center gap-2 text-ink-300">
											<input
												type="checkbox"
												checked={chosen.has(s.id)}
												onChange={() =>
													setChosen((c) => {
														const n = new Set(c);
														if (n.has(s.id)) n.delete(s.id);
														else n.add(s.id);
														return n;
													})
												}
											/>
											<span className="truncate">{s.name || s.firstMessage || s.id}</span>
											<span className="ml-auto shrink-0 font-mono text-xs text-ink-500">{s.modified.slice(0, 10)}</span>
										</label>
									))}
								</div>
							)}
							<p className="text-xs text-ink-500">{t("sessionsHint")}</p>
						</div>
					)}
					<div className="flex items-center gap-3">
						<Button variant="primary" disabled={busy || !prefs.scopes.length} onClick={() => void run()}>
							{busy ? <LoaderCircle className="size-4 animate-spin" /> : prefs.direction === "pull" ? <ArrowDownToLine className="size-4" /> : <ArrowUpFromLine className="size-4" />} {busy ? t("syncing") : t("syncNow")}
						</Button>
						{msg && <span className="min-w-0 text-xs break-words text-ink-400">{msg}</span>}
					</div>
					<div className="space-y-2 border-t border-ink-800 pt-3">
						<label className="flex items-center gap-2 text-sm font-medium text-ink-200">
							<input type="checkbox" checked={prefs.auto} onChange={(e) => set({ auto: e.target.checked, ...(e.target.checked && !prefs.lastRun ? { lastRun: Date.now() } : {}) })} />
							<RefreshCw className="size-3.5" /> {t("auto")}
						</label>
						{prefs.auto && (
							<div className="flex items-center gap-2 text-sm text-ink-400">
								{t("every")}
								<Select value={prefs.intervalMin} onChange={(e) => set({ intervalMin: Number(e.target.value) })} className="w-32">
									{INTERVALS.map((n) => (
										<option key={n} value={n}>
											{t("minutes", { n })}
										</option>
									))}
								</Select>
							</div>
						)}
						<p className="text-xs text-ink-500">{t("autoHint")}</p>
					</div>
					<p className="text-xs text-amber-500/80">{t("secrets")}</p>
				</>
			)}
		</section>
	);
}

/** Mounted once in the app: runs the opt-in automatic sync while connected. Does nothing unless the user turned it on. */
export function useAutoSync(): void {
	const client = useStore((s) => s.client);
	const conn = useStore((s) => s.conn);
	const sync = usePrefs((s) => s.sync);
	const running = useRef(false);
	useEffect(() => {
		if (!sync.auto || !client || conn !== "open") return;
		const tick = async () => {
			if (running.current) return;
			const cur = usePrefs.getState().sync;
			const peer = loadPlatforms().find((p) => p.id === cur.peerId && !samePlatform(p.url, client.target.httpBase));
			if (!peer || !cur.scopes.length) return;
			running.current = true;
			const started = Date.now();
			try {
				await runSync(client, { peer, direction: cur.direction, scopes: cur.scopes, overwrite: cur.overwrite, since: cur.lastRun });
				setPrefs({ sync: { ...usePrefs.getState().sync, lastRun: started } });
				if (cur.direction === "pull") void refreshSessions();
			} catch (err) {
				console.warn("[sync]", err);
			} finally {
				running.current = false;
			}
		};
		const first = setTimeout(() => void tick(), 5_000);
		const timer = setInterval(() => void tick(), Math.max(5, sync.intervalMin) * 60_000);
		return () => {
			clearTimeout(first);
			clearInterval(timer);
		};
	}, [client, conn, sync.auto, sync.peerId, sync.intervalMin]);
}
