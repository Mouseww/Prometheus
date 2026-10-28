// Saving a file from the server's machine to the user's. The transport is the same WebSocket as everything else (so it
// works locally, remotely and in the desktop shell alike): the file arrives in pieces. Where the browser lets us choose
// a destination (File System Access API) the pieces are written straight to disk, which has no size limit; elsewhere
// they are collected in memory and handed to the browser as a download, which is capped.
import { defineMessages, tr } from "./i18n.ts";
import { isTauri } from "./backend.ts";
import { openExternal } from "./links.ts";
import { call, toast, useStore } from "./store.ts";

const M = defineMessages({
	zh: {
		saved: "已保存 {name}",
		failed: "下载失败：{name}",
		tooBig: "文件 {size} 超过浏览器下载上限 {max}，请换用 Chrome 或 Edge，或在服务器上直接取",
		starting: "正在下载 {name}…",
	},
	en: {
		saved: "Saved {name}",
		failed: "Download failed: {name}",
		tooBig: "The file is {size}, over this browser's download limit of {max}. Use Chrome or Edge, or fetch it on the server",
		starting: "Downloading {name}…",
	},
});

const PIECE = 4 * 1024 * 1024;
/** Without a save dialog the whole file sits in memory first. */
export const MEMORY_LIMIT = 256 * 1024 * 1024;

type SavePicker = (options: { suggestedName?: string }) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;

const picker = (): SavePicker | undefined => (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;

export const baseName = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "file";

function bytesOf(base64: string): Uint8Array {
	const bin = atob(base64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const sizeText = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(0)} MB` : `${Math.ceil(n / 1024)} KB`);

/** Hands finished bytes to the browser as a file download. */
function saveBlob(parts: Uint8Array[], name: string): void {
	const url = URL.createObjectURL(new Blob(parts as BlobPart[]));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Download `path` (absolute, or relative to the conversation's folder) from the open conversation. Returns whether it was saved. */
export async function downloadFile(path: string, suggestedName?: string): Promise<boolean> {
	const session = useStore.getState().session;
	if (!session) return false;
	const name = suggestedName || baseName(path);

	// App shells (desktop, Android) cannot save a blob: the system browser fetches the file from the server instead.
	if (isTauri()) {
		const client = useStore.getState().client;
		const link = await call((c) => c.rpc("file.link", { sessionId: session.id, path }));
		if (!client || !link) return false;
		await openExternal(`${client.target.httpBase}/api/download/${encodeURIComponent(link.id)}`);
		return true;
	}

	// The destination dialog needs the click that started this, so it comes before any waiting.
	let sink: Awaited<ReturnType<Awaited<ReturnType<SavePicker>>["createWritable"]>> | undefined;
	const pick = picker();
	if (pick) {
		try {
			sink = await (await pick({ suggestedName: name })).createWritable();
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") return false; // the user closed the dialog
			sink = undefined; // not allowed here (for example an embedded frame): fall back to a normal download
		}
	}

	const abort = async () => {
		await sink?.abort().catch(() => {});
	};
	const info = await call((c) => c.rpc("file.stat", { sessionId: session.id, path }));
	if (!info?.exists || info.size === undefined) {
		await abort();
		if (info) toast(tr(M, "failed", { name }), "error");
		return false;
	}
	if (!sink && info.size > MEMORY_LIMIT) {
		toast(tr(M, "tooBig", { size: sizeText(info.size), max: sizeText(MEMORY_LIMIT) }), "error");
		return false;
	}
	if (info.size > 8 * 1024 * 1024) toast(tr(M, "starting", { name }), "info");

	const parts: Uint8Array[] = [];
	let offset = 0;
	try {
		for (;;) {
			const piece = await call((c) => c.rpc("file.read", { sessionId: session.id, path, offset, length: PIECE }));
			if (!piece) throw new Error("read");
			const data = bytesOf(piece.data);
			if (sink) await sink.write(data);
			else parts.push(data);
			offset += data.length;
			if (piece.eof || data.length === 0) break;
		}
		if (sink) await sink.close();
		else saveBlob(parts, name);
	} catch {
		await abort();
		toast(tr(M, "failed", { name }), "error");
		return false;
	}
	toast(tr(M, "saved", { name }), "info");
	return true;
}

// ---------- does a mentioned path exist? ----------

const known = new Map<string, Promise<boolean>>();

/** Whether the open conversation has a downloadable file at `path`; answers are remembered, so a long chat asks once per path. */
export function fileExists(sessionId: string, path: string): Promise<boolean> {
	const key = `${sessionId}\0${path}`;
	let hit = known.get(key);
	if (!hit) {
		hit = (async () => {
			const client = useStore.getState().client;
			if (!client) return false;
			try {
				return (await client.rpc("file.stat", { sessionId, path })).exists;
			} catch {
				return false;
			}
		})();
		known.set(key, hit);
		// A failed lookup (connection down) must not be remembered as "no such file".
		void hit.then((ok) => ok || known.delete(key));
	}
	return hit;
}

const EXT =
	"pdf|docx?|xlsx?|xlsm|csv|tsv|pptx?|txt|md|markdown|json|jsonl|xml|html?|zip|tar|gz|tgz|7z|rar|png|jpe?g|gif|webp|svg|bmp|ico|mp3|mp4|wav|mov|avi|mkv|ya?ml|toml|ini|sql|ipynb|parquet|db|sqlite|py|js|mjs|ts|tsx|jsx|java|go|rs|c|cpp|h|css|sh|bat|ps1|rtf|odt|ods|epub";
const PATH_LIKE = new RegExp(`^(?:[A-Za-z]:)?[^\\s"'<>|*?:()\\[\\]{}\`]*[^\\s"'<>|*?:()\\[\\]{}\`/\\\\]\\.(?:${EXT})$`, "i");

/** Inline code that reads like the path of a file: worth asking the server whether it is there. */
export function looksLikeFilePath(text: string): boolean {
	return text.length > 3 && text.length < 260 && !text.includes("://") && PATH_LIKE.test(text);
}
