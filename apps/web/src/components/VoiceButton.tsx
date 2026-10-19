import clsx from "clsx";
import { LoaderCircle, Mic, Square } from "lucide-react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { openSettings, pluginActive, toast, useStore } from "../lib/store.ts";
import { useVoiceInput, voiceUnsupportedReason } from "../lib/voice.ts";

const M = defineMessages({
	zh: {
		start: "语音输入",
		stop: "结束录音并识别",
		working: "正在识别…",
		setup: "语音输入还没配置：选择一个支持语音转文字的网关和模型",
		insecure: "浏览器只允许在 HTTPS 或 localhost 页面使用麦克风",
		unsupported: "当前环境不支持录音",
		denied: "无法使用麦克风，请在系统或浏览器设置中允许访问",
		failed: "语音识别失败，请检查 设置 → 语音 中的网关和模型",
		empty: "没有录到声音",
		tooLong: "已达到单次录音上限，正在识别",
	},
	en: {
		start: "Voice input",
		stop: "Stop and transcribe",
		working: "Transcribing…",
		setup: "Voice input isn't set up yet: choose a gateway and model that can transcribe speech",
		insecure: "Browsers only allow the microphone on HTTPS or localhost pages",
		unsupported: "Recording isn't supported here",
		denied: "Can't use the microphone. Allow access in your system or browser settings",
		failed: "Transcription failed. Check the gateway and model in Settings → Voice",
		empty: "No sound was recorded",
		tooLong: "Reached the recording limit, transcribing",
	},
});

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Composer mic button; renders nothing unless the voice plugin is running. */
export function VoiceButton({ onText }: { onText: (text: string, final: boolean) => void }) {
	const t = useT(M);
	const enabled = useStore((s) => pluginActive(s.plugins, "voice"));
	const messages = { denied: t("denied"), failed: t("failed"), empty: t("empty"), tooLong: t("tooLong") };
	const { phase, seconds, state, start, stop, cancel, refresh } = useVoiceInput(onText, messages);
	const blocked = voiceUnsupportedReason();
	if (!enabled) return null;

	const recording = phase === "recording";
	const working = phase === "transcribing";
	const title = working ? t("working") : recording ? t("stop") : blocked ? t(blocked) : state && !state.configured ? t("setup") : t("start");

	return (
		<span className="mr-1 flex items-center gap-1">
			{recording && (
				<button type="button" onClick={cancel} className="rounded px-1.5 py-0.5 font-mono text-[11px] text-ink-400 hover:text-ink-100" aria-label="cancel">
					<span className="mr-1.5 inline-block size-1.5 animate-breathe rounded-full bg-rose-400 align-middle" />
					{fmt(seconds)}
				</button>
			)}
			<button
				type="button"
				disabled={working}
				onClick={async () => {
					if (recording) return stop();
					if (blocked) return toast(t(blocked), "error");
					// Mobile browsers only show the permission prompt while the tap's user activation is alive,
					// so request the microphone synchronously and never await the network first.
					if (state?.configured) {
						void start();
						void refresh();
						return;
					}
					// Not known to be configured: re-read the state (it may predate a save in Settings).
					const fresh = (await refresh()) ?? state;
					if (fresh && !fresh.configured) return openSettings("voice");
					void start();
				}}
				title={title}
				aria-label={title}
				className={clsx(
					"grid size-8 place-items-center rounded-lg transition-colors disabled:opacity-40",
					recording ? "bg-rose-500 text-white hover:bg-rose-400" : "text-ink-400 hover:bg-ink-800 hover:text-ink-100",
					state && !state.configured && !recording && "text-ember-300",
				)}
			>
				{working ? <LoaderCircle className="size-4 animate-spin" /> : recording ? <Square className="size-3.5 fill-current" /> : <Mic className="size-4" />}
			</button>
		</span>
	);
}
