import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { PanelApp } from "./components/PanelApp.tsx";
import { installGlobalGuards } from "./lib/links.ts";
import "./lib/prefs.ts";
import "./styles.css";

installGlobalGuards();

// The desktop tray panel is a second window running this same bundle.
const isPanel = (window as { __PROMETHEUS_PANEL__?: boolean }).__PROMETHEUS_PANEL__ === true;
if (isPanel) document.getElementById("splash")?.remove();

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode>{isPanel ? <PanelApp /> : <App />}</StrictMode>);
