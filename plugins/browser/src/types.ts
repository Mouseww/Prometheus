// Shapes that go to the app UI (mirrored in apps/web/src/components/browser/types.ts, which cannot import server code).

export type BrowserMode = "headless" | "window";

export interface DialogInfo {
	type: "alert" | "confirm" | "prompt" | "beforeunload";
	message: string;
	defaultPrompt?: string;
	url: string;
}

export interface TabInfo {
	id: string;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	/** Opened by the agent (shown with a badge). */
	agent: boolean;
	dialog?: DialogInfo;
	/** A file input asked for files and is waiting. */
	fileChooser?: { multiple: boolean };
	crashed?: boolean;
}

export interface DownloadInfo {
	id: string;
	url: string;
	name: string;
	path: string;
	state: "inProgress" | "completed" | "canceled";
	received: number;
	total: number;
	startedAt: number;
}

export interface InstallState {
	stage: "resolve" | "download" | "extract" | "done" | "error";
	done: number;
	total: number;
	message?: string;
}

export interface AgentState {
	busy: boolean;
	sessionId?: string;
	tab?: string;
	/** What the agent is doing, for the overlay ("click", "navigate", ...). */
	action?: string;
}

export interface Viewport {
	width: number;
	height: number;
	dpr: number;
	/** A phone-sized screen with touch: pages are laid out as on a phone. */
	mobile?: boolean;
}

export interface BrowserState {
	status: "stopped" | "starting" | "running" | "error";
	error?: string;
	mode: BrowserMode;
	browser?: { kind: string; path: string; product: string };
	/** No usable browser was found; the UI offers to download one. */
	missing: boolean;
	canInstall: boolean;
	/** Why this host cannot run the browser at all (the phone's local server). */
	unsupported?: string;
	/** The phone's local server: the browser is a runtime of the app, not something this plugin downloads. */
	guest?: boolean;
	nativeInstall?: { runtime: string };
	install?: InstallState;
	tabs: TabInfo[];
	active: string | null;
	agent: AgentState;
	/** The user took the browser over: agent tools refuse until it is handed back. */
	takeover: boolean;
	downloads: DownloadInfo[];
	viewport: Viewport;
	platform: NodeJS.Platform;
}

/** Input events sent by the UI, in CSS pixels of the page. */
export type InputEvent =
	| { k: "mouse"; type: "mouseMoved" | "mousePressed" | "mouseReleased"; x: number; y: number; button?: "none" | "left" | "middle" | "right" | "back" | "forward"; buttons?: number; clickCount?: number; modifiers?: number }
	| { k: "wheel"; x: number; y: number; dx: number; dy: number; modifiers?: number }
	| { k: "key"; type: "keyDown" | "keyUp" | "rawKeyDown"; key: string; code: string; keyCode: number; text?: string; modifiers?: number; location?: number; repeat?: boolean }
	| { k: "text"; text: string }
	| { k: "ime"; text: string; start: number; end: number }
	| { k: "touch"; type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel"; points: { x: number; y: number; id: number }[]; modifiers?: number };

/** Stream messages on the "view" topic. Frames carry the JPEG as binary. */
export type ViewMessage =
	| { k: "state"; state: BrowserState }
	| { k: "frame"; tab: string; seq: number; width: number; height: number }
	| { k: "cursor"; tab: string; cursor: string }
	| { k: "select"; tab: string; x: number; y: number; rect: [number, number, number, number]; options: { label: string; value: string; disabled: boolean; selected: boolean; group?: string }[] }
	| { k: "menu"; tab: string; x: number; y: number; link?: string; image?: string; selection?: string; editable: boolean }
	| { k: "copy"; tab: string; text: string }
	| { k: "pointer"; tab: string; x: number; y: number; op: string };
