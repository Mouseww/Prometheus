// Previews documents the text viewer cannot show (Word, Excel, PowerPoint, PDF, ...) with Open File
// Viewer. The bytes come over the same chunked file.read as a download; this module is loaded only when such a file is opened.
import { FileViewer } from "@open-file-viewer/react";
import { fallbackPlugin, imagePlugin, officePlugin, pdfPlugin, textPlugin } from "@open-file-viewer/core";
import "@open-file-viewer/core/style.css";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: { failed: "无法预览这个文件", tooBig: "文件超过 {max} MB，请下载后查看" },
	en: { failed: "This file cannot be previewed", tooBig: "The file is over {max} MB; download it to view" },
});

const PIECE = 4 * 1024 * 1024;
const LIMIT_MB = 100;

const plugins = [
	imagePlugin(),
	textPlugin(),
	pdfPlugin({ workerSrc: pdfWorkerSrc }),
	officePlugin(),
	fallbackPlugin(),
];

function bytesOf(base64: string): Uint8Array {
	const bin = atob(base64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export default function DocumentPreview({ path, name, refreshKey }: { path: string; name: string; refreshKey: number }) {
	const t = useT(M);
	const sessionId = useStore((s) => s.session?.id);
	const client = useStore((s) => s.client);
	const [file, setFile] = useState<File | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		setFile(null);
		setError(null);
		void (async () => {
			if (!client || !sessionId) return;
			try {
				const info = await client.rpc("file.stat", { sessionId, path });
				if (!info.exists || info.size === undefined) throw new Error(t("failed"));
				if (info.size > LIMIT_MB * 1024 * 1024) throw new Error(t("tooBig", { max: LIMIT_MB }));
				const parts: Uint8Array[] = [];
				let offset = 0;
				for (;;) {
					const piece = await client.rpc("file.read", { sessionId, path, offset, length: PIECE });
					const data = bytesOf(piece.data);
					parts.push(data);
					offset += data.length;
					if (piece.eof || data.length === 0) break;
				}
				if (live) setFile(new File(parts as BlobPart[], name));
			} catch (err) {
				if (live) setError(err instanceof Error ? err.message : t("failed"));
			}
		})();
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, sessionId, path, name, refreshKey]);

	const viewer = useMemo(() => (file ? <FileViewer file={file} fileName={file.name} width="100%" height="100%" fit="contain" toolbar theme="dark" plugins={plugins} onError={() => setError(t("failed"))} /> : null), [file]); // eslint-disable-line react-hooks/exhaustive-deps
	if (error) return <p className="p-4 text-sm text-ink-500">{error}</p>;
	if (!viewer)
		return (
			<div className="grid h-full place-items-center text-ink-500">
				<LoaderCircle className="size-5 animate-spin" />
			</div>
		);
	return <div className="h-full">{viewer}</div>;
}
