import { LOG_PREFIX, type HubLog } from "./log.ts";

type Closable = { close(): Promise<void> };

/** SIGBREAK is what Windows sends for Ctrl+Break and console close; the others are the usual stop signals. */
const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGBREAK"];

export interface ShutdownOptions {
	log: HubLog;
	/** Called after a clean close; default process.exit(0). */
	exit?: (code: number) => void;
	/** Give up waiting for close after this long (default 10000 ms) and exit with code 1. */
	timeoutMs?: number;
	signals?: NodeJS.Signals[];
}

/**
 * Closes the Hub (and with it PGlite, which writes a final checkpoint) when the process is asked to stop, so a normal stop never
 * relies on write ahead log recovery. Hosts that embed the Hub and already manage signals can call hub.close() themselves instead.
 * Returns a function that removes the handlers.
 */
export function closeOnSignals(hub: Closable, opts: ShutdownOptions): () => void {
	const exit = opts.exit ?? ((code: number) => process.exit(code));
	let stopping = false;
	const handler = (signal: NodeJS.Signals): void => {
		if (stopping) return;
		stopping = true;
		opts.log.info(`${LOG_PREFIX} 收到 ${signal}，正在关闭数据库`);
		const timer = setTimeout(() => {
			opts.log.error(`${LOG_PREFIX} 关闭超时，强制退出`);
			exit(1);
		}, opts.timeoutMs ?? 10_000);
		timer.unref();
		hub.close().then(
			() => {
				clearTimeout(timer);
				exit(0);
			},
			(err: unknown) => {
				clearTimeout(timer);
				opts.log.error(`${LOG_PREFIX} 关闭失败: ${err instanceof Error ? err.message : String(err)}`);
				exit(1);
			},
		);
	};
	const signals = opts.signals ?? STOP_SIGNALS;
	for (const s of signals) process.on(s, handler);
	return () => {
		for (const s of signals) process.off(s, handler);
	};
}
