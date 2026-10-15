import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env.PROMETHEUS_DEV_BACKEND ?? "http://127.0.0.1:7420";

export default defineConfig({
	plugins: [react(), tailwindcss()],
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
