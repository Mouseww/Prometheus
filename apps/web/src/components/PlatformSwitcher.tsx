import clsx from "clsx";
import { Check, ChevronUp, Monitor, Server, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { isTauri, localSupported } from "../lib/backend.ts";
import type { BackendTarget } from "../lib/client.ts";
import { defineMessages, useT } from "../lib/i18n.ts";
import { loadPlatforms, samePlatform, switchLocal, switchPlatform } from "../lib/platforms.ts";
import { openSettings } from "../lib/store.ts";
import { usePopover } from "./TitleBar.tsx";

const M = defineMessages({
	zh: { local: "本机", manage: "管理平台…", none: "还没有保存的平台" },
	en: { local: "This device", manage: "Manage platforms…", none: "No saved platforms" },
});

/** Footer button of the sidebar: shows the connected server and lists saved ones for a quick switch. */
export function PlatformSwitcher({ target }: { target: BackendTarget }) {
	const t = useT(M);
	const { open, setOpen, ref } = usePopover();
	const [canLocal, setCanLocal] = useState(false);
	const isLocal = target.label === "local";
	const list = open ? loadPlatforms() : [];

	useEffect(() => {
		if (isTauri()) void localSupported().then(setCanLocal);
	}, []);

	const item = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-ink-800";
	return (
		<div ref={ref} className="relative min-w-0">
			<button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-ink-800 hover:text-ink-200" title={target.httpBase}>
				<span className="truncate">{isLocal ? t("local") : target.label}</span>
				<ChevronUp className="size-3 shrink-0 opacity-60" />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-40 mb-2 w-64 animate-rise overflow-hidden rounded-xl border border-ink-700 bg-ink-900/97 shadow-2xl shadow-black/40 backdrop-blur">
					<div className="max-h-64 overflow-y-auto py-1">
						{canLocal && (
							<button
								type="button"
								className={clsx(item, isLocal ? "text-ember-200" : "text-ink-200")}
								onClick={() => {
									setOpen(false);
									if (!isLocal) void switchLocal();
								}}
							>
								{isLocal ? <Check className="size-3.5" /> : <Monitor className="size-3.5" />}
								{t("local")}
							</button>
						)}
						{list.length === 0 && !canLocal && <div className="px-3 py-3 text-center text-xs text-ink-500">{t("none")}</div>}
						{list.map((p) => {
							const active = !isLocal && samePlatform(p.url, target.httpBase);
							return (
								<button
									key={p.id}
									type="button"
									title={p.url}
									className={clsx(item, active ? "text-ember-200" : "text-ink-200")}
									onClick={() => {
										setOpen(false);
										if (!active) switchPlatform(p);
									}}
								>
									{active ? <Check className="size-3.5 shrink-0" /> : <Server className="size-3.5 shrink-0" />}
									<span className="min-w-0 flex-1 truncate">{p.name}</span>
								</button>
							);
						})}
					</div>
					<button
						type="button"
						className={clsx(item, "border-t border-ink-800 text-ember-300")}
						onClick={() => {
							setOpen(false);
							openSettings("platforms");
						}}
					>
						<Settings2 className="size-3.5" /> {t("manage")}
					</button>
				</div>
			)}
		</div>
	);
}
