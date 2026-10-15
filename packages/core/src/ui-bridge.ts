import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { UIRequest, UIResponse } from "@prometheus/protocol";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<UIRequest, "id">;

interface Pending {
	request: UIRequest;
	resolve: (response: UIResponse) => void;
}

export interface UIBridgeListener {
	request(request: UIRequest): void;
	resolved(requestId: string): void;
}

/**
 * Turns PI's ExtensionUIContext into wire requests. Blocking dialogs stay pending until any client
 * answers, the extension aborts, or the timeout elapses. Persistent state (status/widgets/title)
 * is retained so late-joining clients can render it from the session snapshot.
 */
export class UIBridge {
	private readonly pending = new Map<string, Pending>();
	readonly statuses = new Map<string, string>();
	readonly widgets = new Map<string, { lines: string[]; placement: string }>();
	title: string | undefined;
	private readonly listener: UIBridgeListener;

	constructor(listener: UIBridgeListener) {
		this.listener = listener;
	}

	pendingRequests(): UIRequest[] {
		return [...this.pending.values()].map((p) => p.request);
	}

	respond(requestId: string, response: UIResponse): boolean {
		const p = this.pending.get(requestId);
		if (!p) return false;
		this.pending.delete(requestId);
		p.resolve(response);
		this.listener.resolved(requestId);
		return true;
	}

	cancelAll(): void {
		for (const id of [...this.pending.keys()]) this.respond(id, { cancelled: true });
	}

	private emit(body: RequestBody): void {
		this.listener.request({ id: randomUUID(), ...body } as UIRequest);
	}

	private dialog<T>(body: RequestBody, opts: ExtensionUIDialogOptions | undefined, fallback: T, map: (r: UIResponse) => T): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(fallback);
		const request = { id: randomUUID(), ...body } as UIRequest;
		return new Promise<T>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (r: UIResponse) => {
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				resolve(map(r));
			};
			const onAbort = () => this.respond(request.id, { cancelled: true });
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) timer = setTimeout(onAbort, opts.timeout);
			this.pending.set(request.id, { request, resolve: finish });
			this.listener.request(request);
		});
	}

	context(): ExtensionUIContext {
		const value = (r: UIResponse) => ("value" in r ? r.value : undefined);
		const ctx = {
			select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
				this.dialog({ method: "select", title, options }, opts, undefined, value),
			confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
				this.dialog({ method: "confirm", title, message }, opts, false, (r) => ("confirmed" in r ? r.confirmed : false)),
			input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
				this.dialog({ method: "input", title, placeholder }, opts, undefined, value),
			editor: (title: string, prefill?: string) => this.dialog({ method: "editor", title, prefill }, undefined, undefined, value),
			notify: (message: string, level: "info" | "warning" | "error" = "info") => this.emit({ method: "notify", message, level }),
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) this.statuses.delete(key);
				else this.statuses.set(key, text);
				this.emit({ method: "setStatus", key, text });
			},
			setWidget: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
				// Component factories are TUI-only; string arrays are the portable form.
				if (content !== undefined && !Array.isArray(content)) return;
				const placement = options?.placement ?? "aboveEditor";
				if (content === undefined) this.widgets.delete(key);
				else this.widgets.set(key, { lines: content as string[], placement });
				this.emit({ method: "setWidget", key, lines: content as string[] | undefined, placement });
			},
			setTitle: (title: string) => {
				this.title = title;
				this.emit({ method: "setTitle", title });
			},
			setEditorText: (text: string) => this.emit({ method: "setEditorText", text }),
			pasteToEditor: (text: string) => this.emit({ method: "setEditorText", text }),
			getEditorText: () => "",
			onTerminalInput: () => () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setFooter: () => {},
			setHeader: () => {},
			custom: async () => {
				ctx.notify("该扩展使用了仅终端可用的自定义界面，请在 TUI 中使用", "warning");
				return undefined;
			},
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			// PI's theme instance is not publicly exported; terminal styling has no meaning in the Web UI.
			theme: undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Web UI 不支持切换终端主题" }),
			getToolsExpanded: () => true,
			setToolsExpanded: () => {},
		};
		return ctx as unknown as ExtensionUIContext;
	}
}
