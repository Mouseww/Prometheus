import { createFeishu } from "./feishu.ts";
import { startQQ } from "./qq.ts";
import { startTelegram } from "./telegram.ts";
import { type Adapter, type AdapterEnv, type ChannelId, type ChannelsConfig, type Deliver } from "./types.ts";
import { createWecom } from "./wecom.ts";

export type { ChannelId, ChannelsConfig } from "./types.ts";

export const CHANNEL_IDS: ChannelId[] = ["telegram", "feishu", "qq", "wecom"];
export const CHANNEL_NAMES: Record<ChannelId, string> = { telegram: "Telegram", feishu: "飞书", qq: "QQ", wecom: "企业微信" };
const SECRET_FIELDS = new Set(["token", "appSecret", "secret", "aesKey", "encryptKey", "verificationToken"]);
const MASK = "••••••";

export interface ChannelsDeps {
	load(): Promise<ChannelsConfig>;
	save(c: ChannelsConfig): Promise<void>;
	/** Run one message through the assistant. `label` is "<channel>:<peer>", one conversation each. */
	ask(label: string, text: string): Promise<{ ok: boolean; reply?: string; error?: string }>;
	log: { info(m: string): void; warn(m: string): void };
	fetch?: typeof fetch;
}

type Feishu = ReturnType<typeof createFeishu>;
type Wecom = ReturnType<typeof createWecom>;

/**
 * IM channels. Every adapter turns a platform message into `deliver(peer, text, reply)`; this is where the sender is
 * checked against the allow list (an unknown sender only learns its own id, never reaches the assistant) and messages
 * are handled one at a time.
 */
export function createChannels(deps: ChannelsDeps) {
	const status: Partial<Record<ChannelId, string>> = {};
	const running = new Map<ChannelId, Adapter>();
	let feishu: Feishu | null = null;
	let wecom: Wecom | null = null;
	let cfg: ChannelsConfig = {};
	let queue: Promise<void> = Promise.resolve();

	const envFor = (id: ChannelId, allow: string[]): AdapterEnv => {
		const deliver: Deliver = async (peer, text, reply) => {
			if (!allow.includes(peer)) {
				await reply(`未授权。你的 ID 是 ${peer}，请在电脑端把它加入 ${CHANNEL_NAMES[id]} 的 allow 名单后再试。`).catch(() => {});
				return;
			}
			// Serialised: the assistant answers one message at a time, replies never interleave.
			queue = queue.then(async () => {
				try {
					const r = await deps.ask(`${id}:${peer}`, text);
					await reply(r.ok ? r.reply || "（没有回复）" : `出错了：${r.error ?? "unknown"}`);
				} catch (e) {
					deps.log.warn(`channel ${id} reply failed: ${(e as Error).message}`);
				}
			});
			await queue;
		};
		return { deliver, log: deps.log, fetch: deps.fetch ?? fetch, setStatus: (s) => void (status[id] = s) };
	};

	const stop = () => {
		for (const a of running.values()) a.stop();
		running.clear();
		feishu = wecom = null;
		for (const k of CHANNEL_IDS) delete status[k];
	};

	const apply = () => {
		stop();
		const { telegram, feishu: f, qq, wecom: w } = cfg;
		if (telegram?.enabled && telegram.token) {
			running.set("telegram", startTelegram(telegram, envFor("telegram", telegram.allow)));
			status.telegram = "connecting";
		}
		if (qq?.enabled && qq.appId && qq.appSecret) {
			running.set("qq", startQQ(qq, envFor("qq", qq.allow)));
			status.qq = "connecting";
		}
		// Webhook channels have nothing to run; they wait for the platform to call in.
		if (f?.enabled && f.appId && f.appSecret && f.verificationToken) (feishu = createFeishu(f, envFor("feishu", f.allow))), (status.feishu = "waiting for events");
		if (w?.enabled && w.corpId && w.secret && w.token && w.aesKey) (wecom = createWecom(w, envFor("wecom", w.allow))), (status.wecom = "waiting for callbacks");
	};

	return {
		async start() {
			cfg = await deps.load();
			apply();
		},
		stop,
		/** Configuration with secrets hidden, plus live state. */
		async view() {
			const out: Record<string, unknown> = {};
			for (const id of CHANNEL_IDS) {
				const c = (cfg[id] ?? { enabled: false, allow: [] }) as unknown as Record<string, unknown>;
				const shown: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(c)) shown[k] = SECRET_FIELDS.has(k) && v ? MASK : v;
				out[id] = { ...shown, status: c.enabled ? (status[id] ?? "stopped") : "off" };
			}
			return out;
		},
		/** Merge a patch for one channel. A masked secret keeps the stored value. */
		async set(id: string, patch: Record<string, unknown>) {
			if (!CHANNEL_IDS.includes(id as ChannelId)) throw new Error(`unknown channel ${id}`);
			const cur = (cfg[id as ChannelId] ?? { enabled: false, allow: [] }) as unknown as Record<string, unknown>;
			const next: Record<string, unknown> = { ...cur };
			for (const [k, v] of Object.entries(patch)) {
				if (v === MASK) continue;
				if (k === "allow") next.allow = (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
				else if (k === "enabled") next.enabled = Boolean(v);
				else if (typeof v === "string" || typeof v === "boolean") next[k] = v;
			}
			next.allow ??= [];
			cfg = { ...cfg, [id]: next };
			await deps.save(cfg);
			apply();
		},
		feishu: (raw: string) => feishu?.(raw) ?? { status: 404, body: { error: "feishu channel is off" } },
		wecom: () => wecom,
	};
}
