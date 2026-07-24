# 5D Tauri multi-platform installer matrix

## Goal
Produce real desktop/mobile installers via GitHub Actions for Windows, macOS, Linux, Android and iOS.

## Implementation
- Desktop Tauri shell starts bundled `prometheus-server` sidecar when present.
- Platform configs:
  - `tauri.windows.conf.json` / `tauri.linux.conf.json` / `tauri.macos.conf.json` set `externalBin`
  - `tauri.android.conf.json` / `tauri.ios.conf.json` / `tauri.mobile.conf.json` clear `externalBin`
- Release workflow jobs: `server`, `web`, `desktop`, `android`, `ios`, `publish`.

## Limits (honest)
- Android CI APK is unsigned/debug-style unless keystore secrets are later added.
- iOS distribution IPA requires Apple team/signing secrets; without them CI ships simulator app zip + Xcode project zip.
- Mobile clients still talk to a control plane endpoint; desktop bundles local sidecar on 127.0.0.1:4310.
