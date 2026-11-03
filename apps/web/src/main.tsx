import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { PanelApp } from "./components/PanelApp.tsx";
import { TrayMenuApp } from "./components/TrayMenuApp.tsx";
import { installBackHandler } from "./lib/back.ts";
import { installGlobalGuards } from "./lib/links.ts";
import "./lib/prefs.ts";
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

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode>{isTrayMenu ? <TrayMenuApp /> : isPanel ? <PanelApp /> : <App />}</StrictMode>);
