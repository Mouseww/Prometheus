import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ImageContent } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { imageSrc } from "../lib/images.ts";

const M = defineMessages({
	zh: { image: "图片", close: "关闭", enlarge: "点击放大" },
	en: { image: "Image", close: "Close", enlarge: "Click to enlarge" },
});

function Lightbox({ image, onClose }: { image: ImageContent; onClose: () => void }) {
	const t = useT(M);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// Only this layer closes; a Modal underneath listens for Escape too.
			e.stopImmediatePropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	return createPortal(
		<div role="dialog" aria-modal aria-label={t("image")} className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-sm" onClick={onClose}>
			<img src={imageSrc(image)} alt="" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
			<button type="button" onClick={onClose} className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-ink-900/80 text-ink-100 hover:bg-ink-800" aria-label={t("close")}>
				<X className="size-5" />
			</button>
		</div>,
		document.body,
	);
}

/** Thumbnails of images in a message or tool result; clicking one opens it full size. */
export function ImageStrip({ images, align = "start" }: { images: ImageContent[]; align?: "start" | "end" }) {
	const t = useT(M);
	const [open, setOpen] = useState<ImageContent | null>(null);
	if (!images.length) return null;
	const single = images.length === 1;
	return (
		<>
			<div className={align === "end" ? "flex flex-wrap justify-end gap-2" : "flex flex-wrap gap-2"}>
				{images.map((img, i) => (
					<button
						key={i}
						type="button"
						onClick={() => setOpen(img)}
						title={t("enlarge")}
						className="overflow-hidden rounded-xl border border-ink-700 bg-ink-950 transition-colors hover:border-ember-500/50"
					>
						<img src={imageSrc(img)} alt={t("image")} loading="lazy" className={single ? "max-h-72 max-w-full object-contain" : "size-32 object-cover"} />
					</button>
				))}
			</div>
			{open && <Lightbox image={open} onClose={() => setOpen(null)} />}
		</>
	);
}
