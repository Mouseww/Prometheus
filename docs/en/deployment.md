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

### Android

Like desktop, the Android build has two modes: **connect to server** (enter the server address and password/token) and **local mode** (the APK bundles Node and the server; they are extracted to the app's private directory on first launch and data stays on the phone). CI builds an arm64 APK on release and uploads it to the Release.

Command-line tools in local mode: the APK bundles `node`, `npm`, `npx`, `git`, `bash` and `rg` (taken from Termux, versions pinned in `apps/desktop/scripts/android-termux.lock.json`; run `node apps/desktop/scripts/android-runtime.ts --update-lock` to upgrade and commit the result). Android only allows executing files inside the native library directory, so these programs are shipped in the APK under names like `lib*.so`; on startup same-named symlinks are created in the app directory and added to `PATH`. The bundled `npx` is a slimmed-down version (the system has no `/usr/bin/env`, so the original cannot start packaged commands). The workspace defaults to `/storage/emulated/0/Prometheus`, which requires granting "All files access" in system settings (the app sends you there on first launch); without it the app falls back to its private directory. A foreground-service notification stays visible so the system does not kill the local server when the app is backgrounded. Limitations: npm packages that need to compile native extensions cannot be installed; Android 12+ phantom-process limits may kill child processes — disable it in developer options, or run `adb shell device_config put activity_manager max_phantom_processes 2147483647`.

Local-mode limitation: knowledge-base vector search (LanceDB) is unavailable on Android; everything else works. If no release signing key is configured, CI signs with a temporary key and the file name contains `-unofficial`, which cannot be installed over a properly signed version; configuring the three repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` produces a proper signature. Local debugging requires JDK 17, the Android SDK and NDK; run `pnpm --filter @prometheus/desktop tauri android init`, then `bundle-server:android` and `android-runtime` (Linux required), and finally `tauri android dev`.
