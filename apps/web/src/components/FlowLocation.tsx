import { useMemo } from "react";
import type { Flow } from "@prometheus/protocol";
import { defineMessages, useT } from "../lib/i18n.ts";
import { useSpace, useStore } from "../lib/store.ts";
import { Field, Select } from "./ui.tsx";

const M = defineMessages({
	zh: {
		where: "运行位置",
		personal: "个人空间",
		hint: "通用流程在哪里运行，步骤的会话和产生的文件就在哪里。",
		bound: "这是项目「{name}」的专属流程，只能在该项目里运行。",
		boundGone: "这条流程绑定的项目已被移除，需要先在编辑页改绑。",
	},
	en: {
		where: "Run in",
		personal: "Personal space",
		hint: "A general flow works where you run it; its chats and files end up there.",
		bound: "This flow belongs to project \"{name}\" and only runs there.",
		boundGone: "The project this flow belongs to was removed; rebind it in the editor first.",
	},
});

/** Where a run starts by default: the personal space when that is shown, otherwise the project of the open chat. */
export function useDefaultLocation(): string {
	const space = useSpace();
	const ws = useStore((s) => s.workspaces);
	const open = useStore((s) => s.session?.workspaceId ?? "");
	return space === "personal" ? "" : ws.some((w) => w.id === open) ? open : "";
}

/** Chooses where a general flow runs. A project flow shows where it is fixed to instead. */
export function LocationField({ flow, value, onChange, label }: { flow: Pick<Flow, "workspaceId">; value: string; onChange: (v: string) => void; label?: string }) {
	const t = useT(M);
	const workspaces = useStore((s) => s.workspaces);
	const home = useStore((s) => s.assistant?.home);
	const bound = useMemo(() => workspaces.find((w) => w.id === flow.workspaceId), [workspaces, flow.workspaceId]);
	if (flow.workspaceId) return <p className="text-xs text-ink-400">{bound ? t("bound", { name: bound.name }) : t("boundGone")}</p>;
	return (
		<Field label={label ?? t("where")} hint={t("hint")}>
			<Select value={value} onChange={(e) => onChange(e.target.value)}>
				<option value="">{t("personal")}</option>
				{workspaces
					.filter((w) => !home || w.path.replaceAll("\\", "/").toLowerCase() !== home.replaceAll("\\", "/").toLowerCase())
					.map((w) => (
						<option key={w.id} value={w.id}>
							{w.name}
						</option>
					))}
			</Select>
		</Field>
	);
}

/** "Project: X" or "General" for a flow, and the place a run happened, as short badge text. */
export function placeLabel(lang: "zh" | "en", loc?: { name: string; personal?: boolean }): string {
	if (!loc) return "";
	return loc.personal ? M[lang].personal : loc.name;
}
