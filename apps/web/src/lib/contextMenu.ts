import { create } from "zustand";

export interface ContextMenuItem {
	label: string;
	run: () => void;
	danger?: boolean;
}

interface MenuState {
	menu: { x: number; y: number; items: ContextMenuItem[] } | null;
}

export const useContextMenu = create<MenuState>(() => ({ menu: null }));

/** Shows Prometheus' own context menu at a viewport position. */
export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
	useContextMenu.setState({ menu: { x, y, items } });
}

export function hideContextMenu(): void {
	if (useContextMenu.getState().menu) useContextMenu.setState({ menu: null });
}
