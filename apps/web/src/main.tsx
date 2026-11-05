import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { PanelApp } from "./components/PanelApp.tsx";
import { TrayMenuApp } from "./components/TrayMenuApp.tsx";
import { installBackHandler } from "./lib/back.ts";
import { installGlobalGuards } from "./lib/links.ts";
import "./lib/prefs.ts";
import { detectHubMode } from "./team/hubMode.ts";
import "./styles.css";

installGlobalGuards();
installBackHandler();

// The desktop tray panel is a second window running this same bundle.
const isPanel = (window as { __PROMETHEUS_PANEL__?: boolean }).__PROMETHEUS_PANEL__ === true;
// ... and so is the tray's right-click menu, which draws only its card on a transparent window.
const isTrayMenu = (window as { __PROMETHEUS_TRAYMENU__?: boolean }).__PROMETHEUS_TRAYMENU__ === true;
if (isPanel || isTrayMenu) document.getElementById("splash")?.remove();
if (isTrayMenu) {
	document.documentElement.style.background = "transparent";
	document.body.style.background = "transparent";
}

// A server started with `--role hub` serves this same bundle: /api/health says so, and then the Hub's own team UI
// replaces the chat app entirely (the chat UI is not even loaded).
const hub = isPanel || isTrayMenu ? false : await detectHubMode();
const HubApp = hub ? (await import("./team/HubApp.tsx")).HubApp : null;

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>{HubApp ? <HubApp /> : isTrayMenu ? <TrayMenuApp /> : isPanel ? <PanelApp /> : <App />}</StrictMode>,
);
