import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env.PROMETHEUS_DEV_BACKEND ?? "http://127.0.0.1:7420";
// The release workflow already requires this file's version to equal the tag.
const { version } = JSON.parse(readFileSync(new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: { __APP_VERSION__: JSON.stringify(version) },
	clearScreen: false,
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/ws": { target: backend.replace(/^http/, "ws"), ws: true },
			"/api": backend,
			"/plugins": backend,
		},
	},
	build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
