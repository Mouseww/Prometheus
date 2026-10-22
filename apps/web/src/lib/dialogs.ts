import { create } from "zustand";

export interface AppDialogRequest {
	id: number;
	kind: "confirm" | "prompt";
	message: string;
	title?: string;
	/** Red confirm button for destructive actions. */
	danger: boolean;
	confirmLabel?: string;
	defaultValue?: string;
	resolve: (value: boolean | string | null) => void;
}

interface DialogState {
	queue: AppDialogRequest[];
}

export const useDialogs = create<DialogState>(() => ({ queue: [] }));
let seq = 0;

function open(req: Omit<AppDialogRequest, "id">): void {
	useDialogs.setState((s) => ({ queue: [...s.queue, { ...req, id: ++seq }] }));
}

/** In-app replacement for window.confirm; resolves false when dismissed. */
export function confirmDialog(message: string, opts: { title?: string; danger?: boolean; confirmLabel?: string } = {}): Promise<boolean> {
	return new Promise((resolve) => open({ kind: "confirm", message, danger: opts.danger ?? true, title: opts.title, confirmLabel: opts.confirmLabel, resolve: (v) => resolve(v === true) }));
}

/** In-app replacement for window.prompt; resolves null when cancelled. */
export function promptDialog(message: string, defaultValue = ""): Promise<string | null> {
	return new Promise((resolve) => open({ kind: "prompt", message, danger: false, defaultValue, resolve: (v) => resolve(typeof v === "string" ? v : null) }));
}

export function settleDialog(id: number, value: boolean | string | null): void {
	const req = useDialogs.getState().queue.find((r) => r.id === id);
	useDialogs.setState((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
	req?.resolve(value);
}
