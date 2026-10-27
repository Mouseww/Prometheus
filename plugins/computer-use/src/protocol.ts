/**
 * The contract between the host and a platform driver. Every driver (Windows UIA, macOS AX,
 * Linux AT-SPI, Android AccessibilityService, adb) speaks this over line-delimited JSON-RPC 2.0;
 * the host never sees platform objects.
 */

export const OPS = [
	"click",
	"double_click",
	"right_click",
	"focus",
	"set_value",
	"type",
	"clear",
	"toggle",
	"select",
	"expand",
	"collapse",
	"scroll",
] as const;
export type Op = (typeof OPS)[number];

/** A normalised accessibility node. `ref` is stable for the element's lifetime within one driver. */
export interface CUNode {
	ref: string;
	role: string;
	name?: string;
	value?: string;
	description?: string;
	/** Platform automation id (AutomationId / AXIdentifier / resource-id). */
	id?: string;
	className?: string;
	states?: string[];
	/** Semantic actions the element supports natively. Pointer fallback works on anything with bounds. */
	actions?: string[];
	/** Screen rectangle [x, y, w, h]; only used for fallbacks, never shown to the model. */
	bounds?: [number, number, number, number];
	children?: CUNode[];
	/** Children the driver did not send because its node budget ran out. */
	omitted?: number;
}

export interface WindowInfo {
	/** Driver-specific window id (HWND, CGWindowID, AT-SPI path, Android window id). */
	id: string;
	pid: number;
	/** Process / app / package name as the user sees it. */
	app: string;
	/** macOS bundle id or Android package, when the platform has one. */
	bundleId?: string;
	title: string;
	className?: string;
	focused: boolean;
	minimized?: boolean;
}

export interface SnapshotResult {
	root: CUNode;
	truncated: boolean;
	focus?: string;
}

export interface DriverHello {
	platform: "windows" | "macos" | "linux" | "android";
	version: string;
	os?: string;
	pid?: number;
	capabilities: string[];
	permissions: Record<string, unknown>;
}

export interface ActResult {
	ok: boolean;
	/** How it was done: a native pattern ("invoke", "value", ...) or "synthetic" input. */
	method: string;
}

/** Error codes drivers put in `error.data.code`. */
export type DriverErrorCode =
	| "unknown_method"
	| "bad_params"
	| "unknown_ref"
	| "stale_ref"
	| "window_gone"
	| "unsupported"
	| "not_found"
	| "input_blocked"
	| "permission_denied"
	| "internal";

export interface DriverMethods {
	hello: { params: Record<string, never>; result: DriverHello };
	/** `all` also returns untitled windows (menu popups, flyouts). */
	"windows.list": { params: { all?: boolean }; result: WindowInfo[] };
	"window.activate": { params: { window: string }; result: ActResult };
	"apps.launch": { params: { target: string; args?: string }; result: { ok: boolean; pid: number | null } };
	"tree.snapshot": { params: { window: string; scope?: string; maxNodes?: number; maxDepth?: number }; result: SnapshotResult };
	"node.act": { params: { ref: string; op: Op; value?: string }; result: ActResult };
	"input.keys": { params: { keys: string; window?: string }; result: ActResult };
	"input.text": { params: { text: string; window?: string }; result: ActResult };
	/**
	 * Block until the window's app has sent no accessibility events for `quietMs` (capability
	 * "settle_events"). Drivers without event support do not implement it; the host then polls.
	 */
	"ui.settle": { params: { window: string; quietMs: number; timeoutMs: number }; result: { settled: boolean; events: number; elapsedMs: number } };
}

export type DriverMethod = keyof DriverMethods;

export interface Driver {
	readonly hello: DriverHello;
	call<M extends DriverMethod>(method: M, params: DriverMethods[M]["params"], timeoutMs?: number): Promise<DriverMethods[M]["result"]>;
	close(): void;
	readonly closed: boolean;
}
