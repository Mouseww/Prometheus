import clsx from "clsx";
import { defineMessages, useT } from "../../../lib/i18n.ts";
import type { SessionStatus } from "../../types.ts";

const S = defineMessages({
	zh: { running: "运行中", waiting: "等待确认", idle: "空闲", offline: "离线" },
	en: { running: "Running", waiting: "Waiting", idle: "Idle", offline: "Offline" },
});

export const useStatusLabel = () => {
	const t = useT(S);
	return (s: SessionStatus): string => t(s);
};

/** Colour of a session status: running green, waiting amber, idle blue, offline grey. */
export const STATUS_TEXT: Record<SessionStatus, string> = {
	running: "text-moss-400",
	waiting: "text-ember-400",
	idle: "text-sky-400",
	offline: "text-ink-500",
};

export const STATUS_BG: Record<SessionStatus, string> = {
	running: "bg-moss-400",
	waiting: "bg-ember-400",
	idle: "bg-sky-400",
	offline: "bg-ink-500",
};

export const STATUS_CHIP: Record<SessionStatus, string> = {
	running: "border-moss-400/40 bg-moss-400/10 text-moss-400",
	waiting: "border-ember-400/40 bg-ember-400/10 text-ember-400",
	idle: "border-sky-400/40 bg-sky-400/10 text-sky-400",
	offline: "border-ink-600 bg-ink-800 text-ink-400",
};

/** Small coloured dot plus the label; the label keeps the status readable without colour. */
export function StatusDot({ status, className }: { status: SessionStatus; className?: string }) {
	const label = useStatusLabel();
	return (
		<span className={clsx("inline-flex items-center gap-1.5 text-xs", STATUS_TEXT[status], className)}>
			<span className={clsx("size-2 rounded-full", STATUS_BG[status], status === "running" && "animate-pulse")} aria-hidden />
			{label(status)}
		</span>
	);
}
