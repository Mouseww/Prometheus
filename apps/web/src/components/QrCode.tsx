import QRCode from "qrcode";
import { useEffect, useState } from "react";

/** Renders `value` as a QR code (black on white so phone cameras read it in dark mode too). */
export function QrCode({ value, size = 176 }: { value: string; size?: number }) {
	const [src, setSrc] = useState("");
	useEffect(() => {
		let live = true;
		void QRCode.toDataURL(value, { margin: 2, width: size * 2, errorCorrectionLevel: "M" }).then((u) => live && setSrc(u), () => live && setSrc(""));
		return () => {
			live = false;
		};
	}, [value, size]);
	if (!src) return <div style={{ width: size, height: size }} />;
	return <img src={src} alt={value} width={size} height={size} className="rounded-lg bg-white" />;
}
