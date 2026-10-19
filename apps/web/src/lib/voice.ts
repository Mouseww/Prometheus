import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceState } from "@prometheus/protocol";
import { pluginCall, toast } from "./store.ts";

export type VoicePhase = "idle" | "recording" | "transcribing";

const MAX_SECONDS = 110;
const WAV_RATE = 16000;
/** How often the audio so far is re-transcribed to refresh the live draft. */
const DRAFT_INTERVAL_MS = 2000;
/** Skip drafts until there is at least this much speech; the server rejects tiny clips. */
const MIN_DRAFT_SECONDS = 0.8;
/** Stop automatically after this long without speech (only once speech has been heard). */
const SILENCE_STOP_MS = 2000;
/** RMS level (0..1) above which a block of audio counts as speech. */
const VOICE_RMS = 0.015;

/** Encodes mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, rate: number): Blob {
	const buf = new ArrayBuffer(44 + samples.length * 2);
	const v = new DataView(buf);
	const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
	str(0, "RIFF");
	v.setUint32(4, 36 + samples.length * 2, true);
	str(8, "WAVE");
	str(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, rate, true);
	v.setUint32(28, rate * 2, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	str(36, "data");
	v.setUint32(40, samples.length * 2, true);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return new Blob([buf], { type: "audio/wav" });
}

/** Linear-interpolation resample; plenty for speech recognition. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
	if (from === to) return input;
	const length = Math.max(1, Math.floor((input.length * to) / from));
	const out = new Float32Array(length);
	const ratio = from / to;
	for (let i = 0; i < length; i++) {
		const pos = i * ratio;
		const i0 = Math.floor(pos);
		const frac = pos - i0;
		out[i] = (input[i0] ?? 0) * (1 - frac) + (input[Math.min(i0 + 1, input.length - 1)] ?? 0) * frac;
	}
	return out;
}

function concat(chunks: Float32Array[]): Float32Array {
	const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

async function toBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Why recording is impossible here, or undefined when it should work. */
export function voiceUnsupportedReason(): "insecure" | "unsupported" | undefined {
	const hasAudioContext = typeof AudioContext !== "undefined" || typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext !== "undefined";
	if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || !hasAudioContext) {
		return window.isSecureContext ? "unsupported" : "insecure";
	}
	return undefined;
}

interface Capture {
	ctx: AudioContext;
	source: MediaStreamAudioSourceNode;
	node: ScriptProcessorNode;
	chunks: Float32Array[];
}

/**
 * Press-to-talk dictation with a live draft: PCM is captured directly, the audio so far is re-transcribed
 * every couple of seconds and handed to `onText(text, false)`, and a final pass on stop yields `onText(text, true)`.
 * `messages` supplies the localized error strings.
 */
export function useVoiceInput(onText: (text: string, final: boolean) => void, messages: { denied: string; failed: string; empty: string; tooLong: string }) {
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const [seconds, setSeconds] = useState(0);
	const [state, setState] = useState<VoiceState | null>(null);
	const capture = useRef<Capture | null>(null);
	const stream = useRef<MediaStream | null>(null);
	const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const draftTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const cancelled = useRef(false);
	const mounted = useRef(true);
	const starting = useRef(false);
	/** Bumped on every start/stop so late draft responses from an earlier take are dropped. */
	const take = useRef(0);
	const onTextRef = useRef(onText);
	onTextRef.current = onText;

	const refresh = useCallback(async () => {
		const s = await pluginCall<VoiceState>("voice", "state");
		if (s && mounted.current) setState(s);
		return s;
	}, []);

	const release = useCallback(() => {
		clearInterval(timer.current);
		clearInterval(draftTimer.current);
		const cap = capture.current;
		capture.current = null;
		if (cap) {
			cap.node.onaudioprocess = null;
			cap.source.disconnect();
			cap.node.disconnect();
			void cap.ctx.close();
		}
		for (const track of stream.current?.getTracks() ?? []) track.stop();
		stream.current = null;
	}, []);

	useEffect(() => {
		mounted.current = true;
		void refresh();
		return () => {
			mounted.current = false;
			cancelled.current = true;
			take.current++;
			release();
		};
	}, [refresh, release]);

	const send = useCallback(async (samples: Float32Array, rate: number): Promise<string> => {
		const wav = encodeWav(resample(samples, rate, WAV_RATE), WAV_RATE);
		const res = await pluginCall<{ text: string }>("voice", "transcribe", { audio: await toBase64(wav), mimeType: "audio/wav" });
		return res?.text ?? "";
	}, []);

	const finish = useCallback(
		async (cap: Capture, id: number) => {
			const rate = cap.ctx.sampleRate;
			const samples = concat(cap.chunks);
			release();
			if (cancelled.current || !mounted.current) return setPhase("idle");
			if (samples.length / rate < 0.3) {
				toast(messages.empty, "warning");
				return setPhase("idle");
			}
			setPhase("transcribing");
			try {
				const text = await send(samples, rate);
				if (text && mounted.current && take.current === id) onTextRef.current(text, true);
			} catch {
				toast(messages.failed, "error");
			} finally {
				if (mounted.current) setPhase("idle");
			}
		},
		[messages, release, send],
	);

	const stop = useCallback(() => {
		const cap = capture.current;
		if (!cap) return;
		const id = ++take.current; // drafts still in flight are now stale
		void finish(cap, id);
	}, [finish]);

	const cancel = useCallback(() => {
		cancelled.current = true;
		take.current++;
		release();
		setPhase("idle");
		onTextRef.current("", true); // drop any live draft
	}, [release]);

	const start = useCallback(async () => {
		if (phase !== "idle" || starting.current || capture.current) return;
		starting.current = true;
		cancelled.current = false;
		let media: MediaStream;
		try {
			media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
		} catch {
			starting.current = false;
			toast(messages.denied, "error");
			return;
		}
		starting.current = false;
		clearInterval(timer.current);
		clearInterval(draftTimer.current);
		stream.current = media;

		const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
		const ctx = new Ctor();
		// iOS Safari starts contexts suspended, which yields silent audio.
		void ctx.resume().catch(() => {});
		const source = ctx.createMediaStreamSource(media);
		const node = ctx.createScriptProcessor(4096, 1, 1);
		const chunks: Float32Array[] = [];
		let heardSpeech = false;
		let lastVoiceAt = Date.now();
		node.onaudioprocess = (e) => {
			const block = new Float32Array(e.inputBuffer.getChannelData(0));
			chunks.push(block);
			let sum = 0;
			for (let i = 0; i < block.length; i++) sum += (block[i] ?? 0) ** 2;
			if (Math.sqrt(sum / block.length) > VOICE_RMS) {
				heardSpeech = true;
				lastVoiceAt = Date.now();
			}
		};
		source.connect(node);
		node.connect(ctx.destination); // the output buffer stays silent; this just keeps the node running
		const cap: Capture = { ctx, source, node, chunks };
		capture.current = cap;

		const id = ++take.current;
		const startedAt = Date.now();
		setSeconds(0);
		setPhase("recording");

		timer.current = setInterval(() => {
			const elapsed = Math.floor((Date.now() - startedAt) / 1000);
			setSeconds(elapsed);
			if (elapsed >= MAX_SECONDS && capture.current === cap) {
				toast(messages.tooLong, "warning");
				stop();
			} else if (heardSpeech && capture.current === cap && Date.now() - lastVoiceAt >= SILENCE_STOP_MS) {
				stop();
			}
		}, 250);

		let inflight = false;
		draftTimer.current = setInterval(async () => {
			if (inflight || capture.current !== cap) return;
			const samples = concat(cap.chunks);
			if (samples.length / ctx.sampleRate < MIN_DRAFT_SECONDS) return;
			inflight = true;
			try {
				const text = await send(samples, ctx.sampleRate);
				// Only show the draft if this take is still recording.
				if (text && mounted.current && take.current === id && capture.current === cap) onTextRef.current(text, false);
			} catch {
				// A failed draft is harmless; the final pass reports real errors.
			} finally {
				inflight = false;
			}
		}, DRAFT_INTERVAL_MS);
	}, [phase, messages, send, stop]);

	return { phase, seconds, state, start, stop, cancel, refresh };
}
