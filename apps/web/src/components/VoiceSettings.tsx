import { Mic } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { VoiceState } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { pluginActive, pluginCall, toast, useStore } from "../lib/store.ts";
import { Button, Empty, Field, Input, PageHeader, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		title: "语音输入",
		subtitle: "把说的话转成文字填进输入框。需要一个支持语音转文字的网关",
		off: "语音插件已停用。到「Prometheus 插件」里重新启用后即可使用",
		gateway: "网关",
		pick: "选择网关",
		model: "识别模型",
		modelHint: "OpenAI 兼容网关填 whisper-1、gpt-4o-transcribe 等；Gemini 网关填 gemini-2.0-flash 等支持音频的模型",
		language: "语言",
		languageHint: "留空则自动识别。填 zh、en、ja 等可提高准确率",
		anthropic: "Anthropic 协议的网关不支持语音转文字",
		save: "保存",
		saved: "已保存",
		noGateways: "还没有可用的网关",
		addGateway: "去添加 AI 网关",
		use: "使用方法：在输入框右下角点击麦克风开始说话，再点一次结束，识别结果会插入光标处。单次最长约 2 分钟。",
		privacy: "录音会发送到你选择的网关进行识别，不会保存在本机。",
	},
	en: {
		title: "Voice input",
		subtitle: "Turn speech into text in the input box. Needs a gateway that can transcribe audio",
		off: "The voice plugin is switched off. Re-enable it under Prometheus Plugins",
		gateway: "Gateway",
		pick: "Choose a gateway",
		model: "Transcription model",
		modelHint: "On OpenAI-compatible gateways use whisper-1, gpt-4o-transcribe and the like; on Gemini use a model that accepts audio, such as gemini-2.0-flash",
		language: "Language",
		languageHint: "Leave empty to auto-detect. Entering zh, en, ja… improves accuracy",
		anthropic: "Anthropic-format gateways can't transcribe speech",
		save: "Save",
		saved: "Saved",
		noGateways: "No gateways available yet",
		addGateway: "Add an AI gateway",
		use: "To use it, click the microphone at the bottom right of the input box, speak, and click again to finish. The text is inserted at the cursor. Up to about 2 minutes at a time.",
		privacy: "Recordings are sent to the gateway you choose for transcription and are not kept on this machine.",
	},
});

export function VoiceSettings() {
	const t = useT(M);
	const enabled = useStore((s) => pluginActive(s.plugins, "voice"));
	const [gateways, setGateways] = useState<{ id: string; name: string; format: string; enabled?: boolean }[]>([]);
	const [form, setForm] = useState({ gatewayId: "", model: "", language: "" });
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const client = useStore.getState().client;
		void client?.rpc("gateway.list", {}).then((list) => setGateways(list.filter((g) => g.enabled !== false)));
		if (!enabled) return setLoaded(true);
		void pluginCall<VoiceState>("voice", "state").then((s) => {
			if (s) setForm({ gatewayId: s.gatewayId, model: s.model, language: s.language });
			setLoaded(true);
		});
	}, [enabled]);

	const options = useMemo(() => gateways.filter((g) => g.format !== "anthropic-messages"), [gateways]);
	const chosen = gateways.find((g) => g.id === form.gatewayId);

	const save = async () => {
		setBusy(true);
		const res = await pluginCall<VoiceState>("voice", "configure", form);
		setBusy(false);
		if (res) toast(t("saved"));
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader title={t("title")} subtitle={t("subtitle")} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
				<div className="max-w-2xl space-y-5">
					{!enabled ? (
						<Empty icon={<Mic className="size-5" />} title={t("off")} />
					) : loaded && gateways.length === 0 ? (
						<Empty icon={<Mic className="size-5" />} title={t("noGateways")} />
					) : (
						<>
							<Field label={t("gateway")}>
								<Select value={form.gatewayId} onChange={(e) => setForm({ ...form, gatewayId: e.target.value })}>
									<option value="">{t("pick")}</option>
									{options.map((g) => (
										<option key={g.id} value={g.id}>
											{g.name}
										</option>
									))}
								</Select>
							</Field>
							{chosen?.format === "anthropic-messages" && <p className="text-xs text-rose-400">{t("anthropic")}</p>}
							<Field label={t("model")} hint={t("modelHint")}>
								<Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="whisper-1" spellCheck={false} className="font-mono" />
							</Field>
							<Field label={t("language")} hint={t("languageHint")}>
								<Input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="zh" className="w-32" />
							</Field>
							<Button variant="primary" disabled={busy || !form.gatewayId || !form.model.trim()} onClick={() => void save()}>
								{t("save")}
							</Button>
							<div className="space-y-1.5 rounded-xl border border-ink-800 bg-ink-900/40 p-4 text-xs leading-relaxed text-ink-400">
								<p>{t("use")}</p>
								<p className="text-ink-500">{t("privacy")}</p>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
