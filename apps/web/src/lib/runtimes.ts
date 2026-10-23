import { create } from "zustand";
import { isTauri, loadMode } from "./backend.ts";

/** One on-demand runtime (Python, Go, Rust, Git, ...) as reported by the desktop/Android shell. */
export interface RuntimeItem {
	id: string;
	name: string;
	description: string;
	version: string;
	sizeMb: number;
	installed: string | null;
	supported: boolean;
	hint: string | null;
	installing: boolean;
	/** Path of the same tool already on PATH. */
	system: string | null;
	/** Linker situation (missing MSVC / Xcode tools / cc). */
	notice: { level: "info" | "warn"; text: string } | null;
	/** Windows: offer installing Visual Studio Build Tools. */
	msvcInstallable: boolean;
}

export type RuntimeStage = "prepare" | "download" | "verify" | "extract" | "setup" | "apt" | "finish";

export interface RuntimeJob {
	id: string;
	stage: RuntimeStage;
	message: string;
	done: number;
	total: number;
	speed: number;
	startedAt: number;
	logs: string[];
	finished: boolean;
	ok: boolean;
	error: string | null;
	/** Hidden from the floating card (the settings page still shows it). */
	dismissed: boolean;
}

interface ProgressEvent {
	id: string;
	stage: RuntimeStage | "log";
	message: string;
	done: number;
	total: number;
	speed: number;
	finished: boolean;
	ok: boolean;
	error: string | null;
	line: string | null;
}

/** The agent ran a command that this machine lacks but an on-demand runtime provides. */
export interface RuntimeRequest {
	id: string;
	command: string;
}

interface RuntimesState {
	/** Pending "the agent needs X, install it?" prompts, by runtime id. */
	requests: Record<string, RuntimeRequest>;
	/** True when this shell can install runtimes (Tauri, local mode). */
	available: boolean;
	/** Why the runtime list could not be loaded (shown on the settings page). */
	loadError: string | null;
	items: RuntimeItem[];
	jobs: Record<string, RuntimeJob>;
	/** A runtime was installed or removed since the local server started; new PATH needs a restart. */
	restartNeeded: boolean;
}

export const useRuntimes = create<RuntimesState>(() => ({ requests: {}, available: false, loadError: null, items: [], jobs: {}, restartNeeded: false }));

const MAX_LOG = 300;
let started = false;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>(cmd, args);
}

export async function refreshRuntimes(): Promise<void> {
	try {
		const items = await invoke<RuntimeItem[]>("runtime_list");
		// In remote mode the agent runs elsewhere, so installing here would change nothing it can see.
		useRuntimes.setState({ items, available: loadMode() !== "remote", loadError: null });
	} catch (err) {
		useRuntimes.setState({ available: false, loadError: String(err) });
	}
}

function blankJob(id: string): RuntimeJob {
	return { id, stage: "prepare", message: "", done: 0, total: 0, speed: 0, startedAt: Date.now(), logs: [], finished: false, ok: false, error: null, dismissed: false };
}

function onEvent(e: ProgressEvent): void {
	useRuntimes.setState((s) => {
		const job = { ...(s.jobs[e.id] ?? blankJob(e.id)) };
		if (e.line) {
			job.logs = [...job.logs, e.line].slice(-MAX_LOG);
		} else if (e.finished) {
			job.finished = true;
			job.ok = e.ok;
			job.error = e.error;
			// Keep the card up on failure; a success dismisses itself from view after a moment.
			job.dismissed = false;
		} else if (e.stage !== "log") {
			if (e.stage !== job.stage) job.startedAt = Date.now();
			job.stage = e.stage;
			job.message = e.message;
			job.done = e.done;
			job.total = e.total;
			job.speed = e.speed;
		}
		return { jobs: { ...s.jobs, [e.id]: job }, restartNeeded: s.restartNeeded || (e.finished && e.ok) };
	});
	if (e.finished) {
		void refreshRuntimes();
		if (e.ok) {
			useRuntimes.setState((s) => {
				const { [e.id]: _done, ...requests } = s.requests;
				return { requests };
			});
			void syncServerEnv();
		}
	}
}

/** Subscribes to install progress once and loads the list. Safe to call from several components. */
export async function initRuntimes(): Promise<void> {
	if (started || !isTauri()) return;
	started = true;
	// The list first: it must not wait on the event subscription.
	const loading = refreshRuntimes();
	try {
		const { listen } = await import("@tauri-apps/api/event");
		await listen<ProgressEvent>("runtime://progress", (ev) => onEvent(ev.payload));
	} catch (err) {
		started = false;
		useRuntimes.setState({ loadError: `event: ${String(err)}` });
	}
	await loading;
}

interface EnvDelta {
	bins: string[];
	env: Record<string, string>;
}

/** Hands the installed runtimes' PATH entries and variables to the running local server, so the next command sees them. */
export async function syncServerEnv(): Promise<void> {
	try {
		const delta = await invoke<EnvDelta>("runtime_env");
		const { useStore } = await import("./store.ts");
		const client = useStore.getState().client;
		if (!client) return;
		// Nothing installed yet leaves the server's own environment alone.
		await client.rpc("runtime.env", delta);
		useRuntimes.setState({ restartNeeded: false });
	} catch {
		// An older server without this RPC, or a remote one: the restart notice stays as the fallback.
	}
}

/** Commands the agent may run, mapped to the runtime that provides them. */
const COMMAND_RUNTIME: Record<string, string> = {
	python: "python",
	python3: "python",
	pip: "python",
	pip3: "python",
	go: "go",
	gofmt: "go",
	cargo: "rust",
	rustc: "rust",
	rustup: "rust",
	git: "git",
};

const NOT_FOUND = [
	/(?:^|[\s'"`(])([\w.+-]+): (?:command )?not found/i, // bash, sh
	/'?([\w.+-]+?)(?:\.exe)?'? is not recognized as/i, // cmd
	/The term '([\w.+-]+?)(?:\.exe)?' is not recognized/i, // PowerShell
	/(?:^|[\s'"])([\w.+-]+): No such file or directory/i,
];

const asked = new Set<string>();

/**
 * Looks at a finished shell command: if it failed because a tool is missing and an on-demand runtime provides it,
 * raises an install prompt. Each runtime is offered once per app run; declining it silences it.
 */
export function noteToolResult(toolName: string, result: unknown): void {
	const state = useRuntimes.getState();
	if (!state.available || (toolName !== "bash" && toolName !== "powershell")) return;
	const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
	// Windows' python.exe Store stub prints this instead of "not found".
	let command = /Python was not found/i.test(text) ? "python" : undefined;
	let id = command ? "python" : undefined;
	if (!id) {
		for (const re of NOT_FOUND) {
			const m = re.exec(text);
			const name = m?.[1]?.toLowerCase();
			if (name && COMMAND_RUNTIME[name]) {
				command = name;
				id = COMMAND_RUNTIME[name];
				break;
			}
		}
	}
	if (!id || !command || asked.has(id)) return;
	const item = state.items.find((i) => i.id === id);
	if (!item || !item.supported || item.installed || item.installing) return;
	asked.add(id);
	useRuntimes.setState((s) => ({ requests: { ...s.requests, [id as string]: { id: id as string, command: command as string } } }));
}

export function dismissRequest(id: string): void {
	useRuntimes.setState((s) => {
		const { [id]: _gone, ...requests } = s.requests;
		return { requests };
	});
}

export async function installRuntime(id: string, localFile?: string): Promise<void> {
	// Show the card at once; the first backend event can take a moment (the checksum file is fetched first).
	dismissRequest(id);
	useRuntimes.setState((s) => ({ jobs: { ...s.jobs, [id]: blankJob(id) } }));
	try {
		await invoke("runtime_install", { id, localFile: localFile || null });
	} catch (err) {
		onEvent({ id, stage: "finish", message: "", done: 0, total: 0, speed: 0, finished: true, ok: false, error: String(err), line: null });
		return;
	}
	await refreshRuntimes();
}

export async function installMsvc(): Promise<void> {
	useRuntimes.setState((s) => ({ jobs: { ...s.jobs, msvc: blankJob("msvc") } }));
	try {
		await invoke("runtime_install_msvc");
	} catch (err) {
		onEvent({ id: "msvc", stage: "finish", message: "", done: 0, total: 0, speed: 0, finished: true, ok: false, error: String(err), line: null });
	}
}

export async function cancelRuntime(id: string): Promise<void> {
	await invoke("runtime_cancel", { id });
}

export async function uninstallRuntime(id: string): Promise<void> {
	await invoke("runtime_uninstall", { id });
	await refreshRuntimes();
	await syncServerEnv();
}

export function dismissRuntimeJob(id: string): void {
	useRuntimes.setState((s) => (s.jobs[id] ? { jobs: { ...s.jobs, [id]: { ...s.jobs[id], dismissed: true } } } : s));
}

export async function restartApp(): Promise<void> {
	await invoke("relaunch_app");
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatEta(job: RuntimeJob): string | null {
	if (job.stage !== "download" || job.speed <= 0 || job.total <= job.done) return null;
	const secs = Math.ceil((job.total - job.done) / job.speed);
	if (secs < 60) return `${secs}s`;
	return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** 0..1, or null when the stage has no measurable progress (installer running, apt, ...). */
export function jobFraction(job: RuntimeJob): number | null {
	if (job.finished) return 1;
	if ((job.stage === "download" || job.stage === "verify" || job.stage === "extract") && job.total > 0) return Math.min(1, job.done / job.total);
	return null;
}
