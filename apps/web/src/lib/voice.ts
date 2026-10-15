import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceState } from "@prometheus/protocol";
import { pluginCall, toast } from "./store.ts";

export type VoicePhase = "idle" | "recording" | "transcribing";

/** Formats MediaRecorder can usually produce, best first; Safari only does mp4. */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
const MAX_SECONDS = 110;

export function pickMime(supported: (m: string) => boolean): string | undefined {
	return MIME_CANDIDATES.find(supported);
}

async function toBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Why recording is impossible here, or undefined when it should work. */
export function voiceUnsupportedReason(): "insecure" | "unsupported" | undefined {
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
		return window.isSecureContext ? "unsupported" : "insecure";
	}
	return undefined;
}

/**
 * Press-to-talk dictation: record, send to the voice plugin, hand the transcript to `onText`.
 * `messages` supplies the localized error strings.
 */
export function useVoiceInput(onText: (text: string) => void, messages: { denied: string; failed: string; empty: string; tooLong: string }) {
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const [seconds, setSeconds] = useState(0);
	const [state, setState] = useState<VoiceState | null>(null);
	const recorder = useRef<MediaRecorder | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const cancelled = useRef(false);
	const mounted = useRef(true);

	const refresh = useCallback(async () => {
		const s = await pluginCall<VoiceState>("voice", "state");
		if (s && mounted.current) setState(s);
	}, []);

	const release = useCallback(() => {
		clearInterval(timer.current);
		for (const track of stream.current?.getTracks() ?? []) track.stop();
		stream.current = null;
		recorder.current = null;
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		return () => {
			mounted.current = false;
			cancelled.current = true;
			if (recorder.current?.state === "recording") recorder.current.stop();
			release();
		};
	}, [refresh, release]);

	const stop = useCallback(() => {
		if (recorder.current?.state === "recording") recorder.current.stop();
	}, []);

	const cancel = useCallback(() => {
		cancelled.current = true;
		stop();
	}, [stop]);

	const start = useCallback(async () => {
		if (phase !== "idle") return;
		cancelled.current = false;
		let media: MediaStream;
		try {
			media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		} catch {
			toast(messages.denied, "error");
			return;
		}
		stream.current = media;
		const mimeType = pickMime((m) => MediaRecorder.isTypeSupported(m));
		const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
		const chunks: Blob[] = [];
		rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
		rec.onstop = async () => {
			const type = rec.mimeType || mimeType || "audio/webm";
			release();
			if (cancelled.current || !mounted.current) return setPhase("idle");
			const blob = new Blob(chunks, { type });
			if (blob.size < 800) {
				toast(messages.empty, "warning");
				return setPhase("idle");
			}
			setPhase("transcribing");
			try {
				const res = await pluginCall<{ text: string }>("voice", "transcribe", { audio: await toBase64(blob), mimeType: type });
				if (res?.text && mounted.current) onText(res.text);
			} catch {
				toast(messages.failed, "error");
			} finally {
				if (mounted.current) setPhase("idle");
			}
		};
		recorder.current = rec;
		rec.start();
		setSeconds(0);
		setPhase("recording");
		timer.current = setInterval(() => {
			setSeconds((s) => {
				if (s + 1 >= MAX_SECONDS) {
					toast(messages.tooLong, "warning");
					rec.state === "recording" && rec.stop();
				}
				return s + 1;
			});
		}, 1000);
	}, [phase, messages, onText, release]);

	return { phase, seconds, state, start, stop, cancel, refresh };
}
