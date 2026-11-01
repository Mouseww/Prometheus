// The phone's local server runs on Termux's Node, where nothing downloaded may be executed. Chromium therefore lives in
// the app's PRoot Ubuntu rootfs (runtime "chromium", see apps/desktop/src-tauri/runtimes.json) and is started through the
// `guestrun` shim the app puts on PATH. Files shared with the browser (profile, downloads, uploads) sit under the
// working directory, which guestrun binds into the rootfs at the same path.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Where the runtime unpacks inside the rootfs (/opt/<runtime id>). */
export const GUEST_RUNTIME = "chromium";
const SHELL_DIR = "chrome-headless-shell-linux-arm64";

export interface Guest {
	/** The `guestrun` shim. */
	runner: string;
	/** Browser path as the rootfs sees it. */
	exe: string;
	/** The same file on the phone's storage, to tell whether the runtime is installed. */
	hostExe: string;
	installed: boolean;
}

export function guestInfo(env: NodeJS.ProcessEnv = process.env): Guest | undefined {
	const rootfs = env.PROMETHEUS_ROOTFS;
	const bin = env.PROMETHEUS_TOOLS_BIN;
	if (!rootfs || !bin) return undefined;
	const rel = `opt/${GUEST_RUNTIME}/${SHELL_DIR}/chrome-headless-shell`;
	const hostExe = join(rootfs, rel);
	return { runner: join(bin, "guestrun"), exe: `/${rel}`, hostExe, installed: existsSync(hostExe) };
}

/** What Chromium needs on top of the usual flags to run under PRoot (no user namespaces, no GPU, small /dev/shm). */
export const GUEST_ARGS = ["--no-sandbox", "--no-zygote", "--disable-gpu", "--disable-dev-shm-usage", "--disable-software-rasterizer", "--renderer-process-limit=2", "--disable-features=VizDisplayCompositor"];
