import clsx from "clsx";
import { defineMessages, useT } from "../lib/i18n.ts";
import type { PanelWidth } from "../lib/panelWidth.ts";

const M = defineMessages({
	zh: { label: "拖动调整宽度，双击恢复默认" },
	en: { label: "Drag to resize, double-click to reset" },
});

/** Drag handle on a panel's edge (desktop only). It must be a direct child of the panel, which needs `relative`. */
export function ResizeHandle({ panel }: { panel: PanelWidth }) {
	const t = useT(M);
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={t("label")}
			title={t("label")}
			aria-valuemin={panel.min}
			aria-valuemax={panel.max}
			aria-valuenow={panel.width ?? undefined}
			tabIndex={0}
			className={clsx("group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none max-md:hidden", panel.edge === "right" ? "-right-1" : "-left-1")}
			{...panel.handleProps}
		>
			<span className={clsx("absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-ember-500/70 group-focus-visible:bg-ember-500/70", panel.dragging ? "bg-ember-500" : "bg-transparent")} />
		</div>
	);
}
