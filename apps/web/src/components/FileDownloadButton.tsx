import { Download, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { defineMessages, useT } from "../lib/i18n.ts";
import { downloadFile, fileExists } from "../lib/download.ts";
import { openFile, pluginActive, useStore } from "../lib/store.ts";

const M = defineMessages({
	zh: { download: "下载" },
	en: { download: "Download" },
});

/** A small download button for the file at `path`; stops clicks so it can sit inside a clickable row. */
export function DownloadButton({ path, name, className = "" }: { path: string; name?: string; className?: string }) {
	const t = useT(M);
	const [busy, setBusy] = useState(false);
	return (
		<span
			role="button"
			tabIndex={0}
			title={t("download")}
			aria-label={t("download")}
			onClick={(e) => {
				e.stopPropagation();
				if (busy) return;
				setBusy(true);
				void downloadFile(path, name).finally(() => setBusy(false));
			}}
			onKeyDown={(e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				e.stopPropagation();
				if (busy) return;
				setBusy(true);
				void downloadFile(path, name).finally(() => setBusy(false));
			}}
			className={`inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded text-ink-500 hover:bg-ink-800 hover:text-ink-100 ${className}`}
		>
			{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
		</span>
	);
}

/** Inline code that names a file the open conversation really has: the code, then a download button. Any other inline code is left plain. */
export function PathCode({ path, children }: { path: string; children: React.ReactNode }) {
	const sessionId = useStore((s) => s.session?.id);
	const cwd = useStore((s) => s.session?.cwd ?? "");
	const viewer = useStore((s) => pluginActive(s.plugins, "workbench"));
	const [exists, setExists] = useState(false);
	useEffect(() => {
		let live = true;
		setExists(false);
		if (sessionId) void fileExists(sessionId, path).then((ok) => live && setExists(ok));
		return () => {
			live = false;
		};
	}, [sessionId, path]);
	return (
		<>
			{exists && viewer ? (
				<code className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-ember-300" title={path} onClick={() => openFile(path, cwd)}>
					{children}
				</code>
			) : (
				<code>{children}</code>
			)}
			{exists && <DownloadButton path={path} className="ml-0.5 align-middle" />}
		</>
	);
}
