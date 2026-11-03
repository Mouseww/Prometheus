# Running and deploying

## Environment

- Node ≥ 22.19 (24 recommended), pnpm 10
- The desktop build additionally needs Rust ≥ 1.77 and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/)

```bash
pnpm install
```

## Running

| Mode | Command | Notes |
|------|---------|-------|
| TUI terminal | `pnpm tui` | PI's native interactive UI; loads gateways and plugins automatically |
| Web server | `pnpm --filter @prometheus/web build && pnpm dev:server` | Open http://127.0.0.1:7420 |
| Web development | `pnpm dev:server` + `pnpm dev:web` | Vite HMR, proxying to 7420 |
| Desktop GUI | `pnpm dev:desktop` | Tauri window; starts the local server for you |
| Desktop packaging | `pnpm --filter @prometheus/desktop build` | Produces an installer (server embedded; requires Node on the machine) |

### Server deployment

A token is mandatory when listening on a non-loopback address:

```bash
docker build -t prometheus .
docker run -p 7420:7420 -e PROMETHEUS_TOKEN=<random string, 16+ chars> \
  -v prometheus-data:/data -v $PWD:/workspace prometheus
```

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `PROMETHEUS_HOST` | `127.0.0.1` | Listen address |
| `PROMETHEUS_PORT` | `7420` | Port; `0` picks a random one |
| `PROMETHEUS_TOKEN` | — | Access token; required when not listening on loopback |
| `PROMETHEUS_HOME` | `~/.prometheus` | Directory for config, knowledge bases and plugin data |
| `PROMETHEUS_CWD` | current directory | Agent working directory |
| `PROMETHEUS_ALLOWED_ORIGINS` | — | Extra allowed browser origins, comma separated |

For public deployments, put it behind an HTTPS reverse proxy.

### LAN and domain access (desktop / local mode)

By default the app listens only on loopback. In **Settings → Network access** you can:

- Set a login password (at least 8 characters) and enable "Allow LAN access". **LAN access cannot be enabled without a password.**
- Fill in a domain allow list (`agent.example.com` or `*.example.com`); you can then use nginx or another reverse proxy to forward the domain to the "LAN port" (7421 by default). Access by IP is not subject to the domain allow list.

Access rules:

| Source | Password required |
|--------|-------------------|
| Direct local access (local port, no proxy) | No |
| LAN IP, domain, or requests forwarded through a reverse proxy | Yes; a login stays valid for 30 days |

Only clients on the same machine can change these settings; devices logged in over the LAN or a domain get read-only view. Changing the password or clicking "Sign out all devices" invalidates every logged-in device. Repeated wrong passwords are rate limited. If you deploy with a non-loopback `PROMETHEUS_HOST`, the token scheme above applies instead and these settings have no effect (the desktop's built-in server binds to loopback with a token, and the settings remain editable).

The reverse proxy must preserve the `Upgrade` header and should use HTTPS; see the settings page for examples. If a browser on the same machine also goes through that reverse proxy, it is treated as external access and will require a password.

### One-click public address (Cloudflare quick tunnel)

If you do not want to set up a domain, reverse proxy and DDNS, turn on "One-click public address" in **Settings → Network access**. The server starts `cloudflared tunnel` (Cloudflare's free quick tunnel), gets a random `https://xxxx.trycloudflare.com` and forwards it to the local server.

- **A login password must be set first**, or it cannot be turned on. Requests through the tunnel are treated as proxied requests and need the password; the tunnel hostname is added to the allow list only while it is on.
- On first use cloudflared is downloaded into `bin/` in the data directory (an existing one on `PATH` is used as is). The download uses `curl` and honours `HTTPS_PROXY` / `ALL_PROXY` and similar variables; on Windows the system proxy is read too.
- The address is temporary: it changes after you turn the switch off or restart, and the switch is not persisted. It is a free tunnel with no stability guarantee, not meant for long-term production use.
- When the download fails, cloudflared exits or no address arrives, the page says it is a network problem; retry after the network (or the proxy's global / TUN mode) is back.
- The same page shows QR codes for the LAN and public addresses; tap "Scan" on the phone's connect page to fill the address in. Android asks for the camera permission (`CAMERA`). Scanning in a plain web page needs an HTTPS page.

### Bundled Node runtime

The desktop installer **no longer ships Node or the PI Agent**, which keeps it small. Node is required by the backend and is installed in one click on first use (choosing "This computer" on the connect page opens a setup step, and Settings -> Runtimes manages or removes it afterwards); it is the official distribution (a pinned 22.x release, SHA-256 verified, with npm and npx). **The PI Agent is an optional agent engine, on a par with Claude Code and Codex**: as long as any one of them works, PI is not required. When none does, the app asks you to install one of the supported agents, with PI preselected (`@earendil-works/pi-*`, installed with npm into the app's data folder `runtimes/pi-agent`, nothing system-wide), and restarts the backend afterwards. LanceDB (vector search, about 320 MB) and the Claude Agent SDK (about 30 MB) are no longer in the installer either: the server installs them with npm into `packages/<name>` in the data folder (the knowledge page and the Claude Code "Install" button trigger it, via the `package.optionalInstall` RPC), and a resolve hook in the launcher makes them usable right after installing, without a restart. Without LanceDB you can still create knowledge bases but not search them by vector (a banner at the top of the page offers the install). The server bundle is about 20 MB as a result. Without PI the server starts normally; PI-specific features (PI packages, the skill library, the MCP client, gateway connectivity tests) are unavailable, and the other agents are unaffected. Node lookup order: `PROMETHEUS_NODE` -> the Node installed by the app -> `PATH` and common install locations (Homebrew, nvm, volta, asdf, fnm; it must be >= 22.19, older ones are ignored). `main.js` in the server bundle is only a launcher: when `PROMETHEUS_PI_DIR` (set automatically by the desktop shell) contains the PI Agent it lets the server import it from there; the server itself is `app.js`. The manifest is `apps/desktop/src-tauri/runtimes.json`, and the PI version has to match the workspace dependencies (checked by `apps/desktop/test/runtimesManifest.test.ts`). Self-contained flavours are unchanged: the Android build and the Electron build for macOS 10.15 still carry Node and the PI Agent (`SERVER_BUNDLE_PI=1` forces it). Releases build macOS twice, Apple Silicon (`macos-latest`) and Intel (`macos-15-intel`); the Intel build has no LanceDB native binding, so knowledge-base vector search is unavailable there and everything else works.

### Android

Like desktop, the Android build has two modes: **connect to server** (enter the server address and password/token) and **local mode** (the APK bundles Node and the server; they are extracted to the app's private directory on first launch and data stays on the phone). CI builds an arm64 APK on release and uploads it to the Release.

Command-line tools in local mode: the APK bundles `node`, `npm`, `npx`, `git`, `bash` and `rg` (taken from Termux, versions pinned in `apps/desktop/scripts/android-termux.lock.json`; run `node apps/desktop/scripts/android-runtime.ts --update-lock` to upgrade and commit the result). Android only allows executing files inside the native library directory, so these programs are shipped in the APK under names like `lib*.so`; on startup same-named symlinks are created in the app directory and added to `PATH`. The bundled `npx` is a slimmed-down version (the system has no `/usr/bin/env`, so the original cannot start packaged commands). The workspace defaults to `/storage/emulated/0/Prometheus`, which requires granting "All files access" in system settings (the app sends you there on first launch); without it the app falls back to its private directory. A foreground-service notification stays visible so the system does not kill the local server when the app is backgrounded. Limitations: npm packages that need to compile native extensions cannot be installed; Android 12+ phantom-process limits may kill child processes — disable it in developer options, or run `adb shell device_config put activity_manager max_phantom_processes 2147483647`.

Local-mode limitation: knowledge-base vector search (LanceDB) is unavailable on Android; everything else works. If no release signing key is configured, CI signs with a temporary key and the file name contains `-unofficial`, which cannot be installed over a properly signed version; configuring the three repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` produces a proper signature. Local debugging requires JDK 17, the Android SDK and NDK; run `pnpm --filter @prometheus/desktop tauri android init`, then `bundle-server:android` and `android-runtime` (Linux required), and finally `tauri android dev`.
