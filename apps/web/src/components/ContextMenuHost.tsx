import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hideContextMenu, useContextMenu } from "../lib/contextMenu.ts";

export function ContextMenuHost() {
	const menu = useContextMenu((s) => s.menu);
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ x: 0, y: 0 });

	useLayoutEffect(() => {
		if (!menu || !ref.current) return;
		const r = ref.current.getBoundingClientRect();
		setPos({ x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)) });
	}, [menu]);

	useEffect(() => {
		if (!menu) return;
		const close = () => hideContextMenu();
		const key = (e: KeyboardEvent) => e.key === "Escape" && close();
		window.addEventListener("keydown", key);
		window.addEventListener("blur", close);
		window.addEventListener("resize", close);
		window.addEventListener("wheel", close, { passive: true });
		return () => {
			window.removeEventListener("keydown", key);
			window.removeEventListener("blur", close);
			window.removeEventListener("resize", close);
			window.removeEventListener("wheel", close);
		};
	}, [menu]);

	if (!menu) return null;
	return createPortal(
		<div className="fixed inset-0 z-[70]" onMouseDown={hideContextMenu} onContextMenu={(e) => { e.preventDefault(); hideContextMenu(); }}>
			<div
				ref={ref}
				role="menu"
				style={{ left: pos.x, top: pos.y }}
				className="fixed min-w-44 animate-rise rounded-xl border border-ink-700 bg-ink-900 p-1 text-sm shadow-2xl shadow-black/50"
				onMouseDown={(e) => e.stopPropagation()}
			>
				{menu.items.map((it) => (
					<button
						key={it.label}
						type="button"
						role="menuitem"
						className={clsx("flex w-full rounded-lg px-3 py-1.5 text-left transition-colors", it.danger ? "text-rose-400 hover:bg-rose-400/10" : "text-ink-200 hover:bg-ink-800")}
						onClick={() => {
							hideContextMenu();
							it.run();
						}}
					>
						{it.label}
					</button>
				))}
			</div>
		</div>,
		document.body,
	);
}
