import { useCallback, useEffect, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginCall, toast, useStore } from "../lib/store.ts";
import { Button, Field, Input, PageHeader } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "IM 通道",
		subtitle: "让 Telegram、飞书、QQ、企业微信里的消息直达个人助理（只读）。每个发消息的人有自己的对话",
		off: "个人助理插件未启用",
		enabled: "启用",
		allow: "允许的发送者 ID",
		allowHint: "逗号或空格分隔。不在名单里的人只会收到自己的 ID，可以让对方先发一条消息拿到它",
		save: "保存",
		saved: "已保存",
		status: "状态",
		callback: "回调地址（把 <公网地址> 换成本服务器可被访问的地址）",
		wechat: "个人微信没有官方接口，未内置。可用第三方桥接工具把消息转到 POST /plugins/assistant/inbound。",
		secretHint: "已保存的密钥显示为圆点，不改就保持原值",
	},
	en: {
		title: "IM channels",
		subtitle: "Send messages from Telegram, Feishu, QQ and WeCom straight to the personal assistant (read-only). Each sender gets a conversation of their own",
		off: "The personal assistant plugin is off",
		enabled: "Enabled",
		allow: "Allowed sender IDs",
		allowHint: "Comma or space separated. Anyone else only gets their own ID back; have them send a message to learn it",
		save: "Save",
		saved: "Saved",
		status: "Status",
		callback: "Callback URL (replace <public-host> with an address that reaches this server)",
		wechat: "Personal WeChat has no official API and is not built in. Bridge it with a third-party tool that posts to /plugins/assistant/inbound.",
		secretHint: "Saved secrets show as dots; leave them to keep the stored value",
	},
});

interface FieldDef {
	key: string;
	label: string;
	secret?: boolean;
	optional?: boolean;
}
const CHANNELS: { id: string; name: string; fields: FieldDef[]; callback?: string }[] = [
	{ id: "telegram", name: "Telegram", fields: [{ key: "token", label: "Bot token", secret: true }] },
	{
		id: "feishu",
		name: "飞书 / Feishu",
		fields: [
			{ key: "appId", label: "App ID" },
			{ key: "appSecret", label: "App Secret", secret: true },
			{ key: "verificationToken", label: "Verification Token", secret: true },
			{ key: "encryptKey", label: "Encrypt Key", secret: true, optional: true },
		],
		callback: "/plugins/assistant/hook/feishu",
	},
	{
		id: "qq",
		name: "QQ",
		fields: [
			{ key: "appId", label: "App ID" },
			{ key: "appSecret", label: "App Secret", secret: true },
		],
	},
	{
		id: "wecom",
		name: "企业微信 / WeCom",
		fields: [
			{ key: "corpId", label: "Corp ID" },
			{ key: "agentId", label: "Agent ID" },
			{ key: "secret", label: "Secret", secret: true },
			{ key: "token", label: "Token", secret: true },
			{ key: "aesKey", label: "EncodingAESKey", secret: true },
		],
		callback: "/plugins/assistant/hook/wecom",
	},
];

type View = Record<string, Record<string, unknown>>;

function ChannelCard({ def, value, onSaved }: { def: (typeof CHANNELS)[number]; value: Record<string, unknown>; onSaved: (v: View) => void }) {
	const t = useT(M);
	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const [busy, setBusy] = useState(false);
	const get = (k: string): string => String(k in draft ? draft[k] : (value[k] ?? ""));
	const allow = "allow" in draft ? String(draft.allow) : ((value.allow as string[] | undefined) ?? []).join(", ");
	const enabled = "enabled" in draft ? Boolean(draft.enabled) : Boolean(value.enabled);
	const patch = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));

	const save = async () => {
		setBusy(true);
		const next = await pluginCall<View>("assistant", "channels.set", { channel: def.id, config: { ...draft, allow } });
		setBusy(false);
		if (!next) return toast("Failed", "error");
		setDraft({});
		onSaved(next);
		toast(t("saved"), "info");
	};

	return (
		<section className="space-y-3 rounded-xl border border-ink-800 p-4">
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-medium text-ink-100">{def.name}</h2>
				<label className="flex items-center gap-2 text-xs text-ink-300">
					<input type="checkbox" checked={enabled} onChange={(e) => patch("enabled", e.target.checked)} />
					{t("enabled")}
				</label>
			</div>
			<div className="text-xs text-ink-500">
				{t("status")}: {String(value.status ?? "off")}
			</div>
			{def.fields.map((f) => (
				<Field key={f.key} label={f.label + (f.optional ? " (optional)" : "")}>
					<Input type={f.secret ? "password" : "text"} value={get(f.key)} onChange={(e) => patch(f.key, e.target.value)} autoComplete="off" />
				</Field>
			))}
			<Field label={t("allow")} hint={t("allowHint")}>
				<Input value={allow} onChange={(e) => patch("allow", e.target.value)} />
			</Field>
			{def.callback && (
				<Field label={t("callback")}>
					<code className="block rounded bg-ink-900 px-2 py-1 text-xs break-all text-ink-300">{`https://<public-host>${def.callback}`}</code>
				</Field>
			)}
			<Button onClick={() => void save()} disabled={busy || Object.keys(draft).length === 0}>
				{t("save")}
			</Button>
		</section>
	);
}

export function ChannelsSettings() {
	const t = useT(M);
	const active = useStore((s) => Boolean(s.assistant));
	const [view, setView] = useState<View | null>(null);
	const load = useCallback(async () => {
		const v = await pluginCall<View>("assistant", "channels");
		if (v) setView(v);
	}, []);
	useEffect(() => {
		if (active) void load();
	}, [active, load]);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4 @3xl:p-8">
				<div className="max-w-2xl space-y-5">
					{!active || !view ? (
						<p className="text-sm text-ink-400">{t("off")}</p>
					) : (
						<>
							<p className="text-xs text-ink-500">{t("secretHint")}</p>
							{CHANNELS.map((c) => (
								<ChannelCard key={c.id} def={c} value={view[c.id] ?? {}} onSaved={setView} />
							))}
							<p className="text-xs text-ink-500">{t("wechat")}</p>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
