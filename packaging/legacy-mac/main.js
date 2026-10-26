// Electron shell for macOS 10.15, whose system WebKit (Safari 13) cannot render the UI: it starts the bundled
// server (run by Electron's own Node, no separate runtime needed) and shows its web UI in a Chromium window.
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// A fixed port keeps the page origin (and so localStorage: settings, history) the same between launches.
const PREFERRED_PORT = 17420;
let server = null;
let win = null;
let serverPort = 0;

const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../dist");
const entry = path.join(resources, app.isPackaged ? "server" : "server-bundle", "main.js");
const nodeBin = path.join(resources, app.isPackaged ? "node" : "node-runtime", "bin");

function portFree(port) {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.once("error", () => resolve(false));
		s.once("listening", () => s.close(() => resolve(true)));
		s.listen(port, "127.0.0.1");
	});
}

async function startServer() {
	if (!fs.existsSync(entry)) throw new Error(`server entry missing: ${entry}`);
	const port = (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : 0;
	// Bundled npm/npx go last so tools the user installed win; GUI launches lack Homebrew's directories.
	const pathEnv = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin", nodeBin].join(":");
	server = spawn(process.execPath, ["--import", pathToFileURL(path.join(path.dirname(entry), "polyfills.js")).href, entry], {
		cwd: app.getPath("home"),
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			PATH: pathEnv,
			PROMETHEUS_HOST: "127.0.0.1",
			PROMETHEUS_PORT: String(port),
			PROMETHEUS_PARENT_WATCH: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let tail = "";
	const keep = (b) => { tail = (tail + b.toString()).slice(-4000); };
	server.stderr.on("data", keep);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`server did not start in 90s\n${tail}`)), 90000);
		server.stdout.on("data", (b) => {
			keep(b);
			const m = /PROMETHEUS_READY (\d+)/.exec(b.toString());
			if (m) { clearTimeout(timer); resolve(Number(m[1])); }
		});
		server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited (${code})\n${tail}`)); });
	});
}

function createWindow(port) {
	win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 880,
		minHeight: 560,
		backgroundColor: "#1c1814",
		title: "Prometheus",
		webPreferences: { contextIsolation: true, sandbox: true },
	});
	const origin = `http://127.0.0.1:${port}`;
	win.loadURL(origin);
	// Anything that is not the app itself opens in the real browser.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (e, url) => {
		if (!url.startsWith(origin)) { e.preventDefault(); if (/^(https?|mailto):/.test(url)) void shell.openExternal(url); }
	});
	win.on("closed", () => { win = null; });
}

function stopServer() {
	if (server && !server.killed) server.kill();
	server = null;
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
	Menu.setApplicationMenu(Menu.buildFromTemplate([
		{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
	]));
	try {
		serverPort = await startServer();
		createWindow(serverPort);
	} catch (e) {
		dialog.showErrorBox("Prometheus failed to start", String(e && e.message || e));
		app.quit();
	}
});
app.on("activate", () => { if (!win && server) createWindow(serverPort); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", stopServer);
process.on("exit", stopServer);
