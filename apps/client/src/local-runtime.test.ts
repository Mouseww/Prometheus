import { afterEach, expect, it } from "vitest";
import { isServerHostedUi, isTauriDesktop } from "./local-runtime";
import { getControlPlaneMode, getDefaultControlPlaneUrl, setControlPlaneMode } from "./api";

afterEach(() => {
  const candidate = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    isTauri?: boolean;
  };
  delete candidate.__TAURI_INTERNALS__;
  delete candidate.__TAURI__;
  delete candidate.isTauri;
  try {
    globalThis.localStorage?.removeItem("prometheus.controlPlaneMode");
    globalThis.localStorage?.removeItem("prometheus.controlPlaneUrl");
  } catch {
    // ignore
  }
});

it("detects tauri desktop from runtime globals", () => {
  expect(isTauriDesktop()).toBe(false);
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  expect(isTauriDesktop()).toBe(true);
});

it("treats :4310 origins as server-hosted UI in development", () => {
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, port: "4310", origin: "http://127.0.0.1:4310" },
  });
  expect(isServerHostedUi()).toBe(true);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, port: "5173", origin: "http://127.0.0.1:5173" },
  });
  expect(isServerHostedUi()).toBe(false);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: original,
  });
});

it("defaults to local control-plane mode", () => {
  expect(getControlPlaneMode()).toBe("local");
  expect(setControlPlaneMode("remote")).toBe("remote");
  expect(getControlPlaneMode()).toBe("remote");
  expect(setControlPlaneMode("local")).toBe("local");
  expect(getControlPlaneMode()).toBe("local");
});

it("uses same-origin defaults for server-hosted control plane pages", () => {
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, port: "4310", origin: "http://192.168.1.20:4310" },
  });
  expect(getDefaultControlPlaneUrl()).toBe("http://192.168.1.20:4310");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: original,
  });
});
