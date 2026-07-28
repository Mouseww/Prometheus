export type LocalRuntimeStatus = {
  available: boolean;
  running: boolean;
  healthy: boolean;
  host: string;
  port: number;
  url: string;
  workspaceRoot: string;
  binaryPath?: string | null;
  message: string;
  desktop: boolean;
};

export function isTauriDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const candidate = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    isTauri?: boolean;
  };
  return Boolean(candidate.__TAURI_INTERNALS__ || candidate.__TAURI__ || candidate.isTauri);
}

export function isServerHostedUi(): boolean {
  if (typeof window === "undefined") return false;
  // Production SPA is served by control plane itself.
  if (import.meta.env.PROD) return true;
  const port = window.location.port;
  return port === "4310" || port === "";
}

async function invokeCommand<T>(command: string): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(command);
}

export async function getLocalRuntimeStatus(): Promise<LocalRuntimeStatus | null> {
  if (!isTauriDesktop()) return null;
  try {
    return await invokeCommand<LocalRuntimeStatus>("local_runtime_status");
  } catch {
    return null;
  }
}

export async function ensureLocalRuntime(): Promise<LocalRuntimeStatus | null> {
  if (!isTauriDesktop()) return null;
  return invokeCommand<LocalRuntimeStatus>("ensure_local_runtime");
}

export async function restartLocalRuntime(): Promise<LocalRuntimeStatus | null> {
  if (!isTauriDesktop()) return null;
  return invokeCommand<LocalRuntimeStatus>("restart_local_runtime");
}
