import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { Button } from "./ui.tsx";

const M = defineMessages({
	zh: { hint: "把二维码对准取景框", denied: "没有相机权限。请在系统设置里允许 Prometheus 使用相机后重试", noCamera: "无法打开相机", cancel: "取消" },
	en: { hint: "Point the camera at the QR code", denied: "Camera permission was denied. Allow camera access for Prometheus in system settings and try again", noCamera: "Cannot open the camera", cancel: "Cancel" },
});

/** Full-screen camera view; calls onResult once with the first QR text found. The camera is released on unmount. */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
	const t = useT(M);
	const video = useRef<HTMLVideoElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stream: MediaStream | undefined;
		let raf = 0;
		let stopped = false;
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		const tick = () => {
			const v = video.current;
			if (stopped || !v || !ctx) return;
			if (v.readyState >= 2 && v.videoWidth > 0) {
				canvas.width = v.videoWidth;
				canvas.height = v.videoHeight;
				ctx.drawImage(v, 0, 0);
				const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
				const code = jsQR(img.data, img.width, img.height);
				if (code?.data) {
					stopped = true;
					onResult(code.data);
					return;
				}
			}
			raf = requestAnimationFrame(tick);
		};
		if (!navigator.mediaDevices?.getUserMedia) setError(t("noCamera"));
		else
			navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(
				(s) => {
					if (stopped) return s.getTracks().forEach((x) => x.stop());
					stream = s;
					const v = video.current;
					if (v) {
						v.srcObject = s;
						void v.play().catch(() => undefined);
					}
					raf = requestAnimationFrame(tick);
				},
				(err: unknown) => setError(err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError") ? t("denied") : t("noCamera")),
			);
		return () => {
			stopped = true;
			cancelAnimationFrame(raf);
			stream?.getTracks().forEach((x) => x.stop());
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/90 p-4">
			{error ? (
				<p className="max-w-sm rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-400">{error}</p>
			) : (
				<>
					<video ref={video} playsInline muted className="max-h-[70vh] w-full max-w-sm rounded-2xl bg-black object-cover" />
					<p className="text-sm text-ink-300">{t("hint")}</p>
				</>
			)}
			<Button variant="outline" onClick={onClose}>
				{t("cancel")}
			</Button>
		</div>
	);
}
