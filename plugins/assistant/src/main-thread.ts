export interface MainThreadDeps {
	read(): Promise<{ sessionId?: string }>;
	write(state: { sessionId: string }): Promise<void>;
	exists(sessionId: string): Promise<boolean>;
	create(): Promise<{ sessionId: string }>;
}

/**
 * One long-running conversation for the assistant: the same chat every time, so it keeps what was said. A new one is
 * started only when there is none yet or the saved one was deleted. Concurrent callers share one creation.
 */
export function mainThread(deps: MainThreadDeps): () => Promise<{ sessionId: string; created: boolean }> {
	let pending: Promise<{ sessionId: string; created: boolean }> | undefined;
	return () => {
		pending ??= (async () => {
			const saved = (await deps.read()).sessionId;
			if (saved && (await deps.exists(saved))) return { sessionId: saved, created: false };
			const { sessionId } = await deps.create();
			await deps.write({ sessionId });
			return { sessionId, created: true };
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	};
}
