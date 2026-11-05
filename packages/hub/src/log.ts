/** Minimal logger the Hub writes through; messages are Chinese and carry the `[prometheus-hub]` prefix. */
export interface HubLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export const LOG_PREFIX = "[prometheus-hub]";

export function stderrLog(): HubLog {
	const write = (level: string, message: string): void => {
		process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
	};
	return { info: (m) => write("INFO", m), warn: (m) => write("WARN", m), error: (m) => write("ERROR", m) };
}

export const silentLog: HubLog = { info: () => {}, warn: () => {}, error: () => {} };
