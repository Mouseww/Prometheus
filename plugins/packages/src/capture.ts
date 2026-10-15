import type { ChildProcess } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

type SpawnCapture = (command: string, args: string[], options?: { cwd?: string }) => ChildProcess;

/**
 * PI runs npm/git with inherited stdio, so a failure only says "failed with code 1" and the output is lost.
 * Replace its command runner with one that pipes the output into `sink`; returns false if PI's internals changed.
 */
export function captureCommandOutput(manager: object, sink: (chunk: string) => void, timeoutMs = DEFAULT_TIMEOUT_MS): boolean {
	const spawn = Reflect.get(manager, "spawnCaptureCommand") as SpawnCapture | undefined;
	if (typeof spawn !== "function") return false;

	const run = (command: string, args: string[], options?: { cwd?: string }): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			sink(`$ ${command} ${args.join(" ")}\n`);
			let child: ChildProcess;
			try {
				child = spawn.call(manager, command, args, { cwd: options?.cwd });
			} catch (err) {
				reject(err);
				return;
			}
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`执行超时（${Math.round(timeoutMs / 1000)} 秒）：${command}`));
			}, timeoutMs);
			child.stdout?.on("data", (d: Buffer) => sink(d.toString("utf8")));
			child.stderr?.on("data", (d: Buffer) => sink(d.toString("utf8")));
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`${command} 退出码 ${code}`));
			});
		});

	Reflect.set(manager, "runCommand", run);
	return true;
}
