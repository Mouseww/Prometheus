# Sidecar binaries

CI copies the platform-specific `prometheus-server` control-plane binary here before `tauri build`.

Expected filenames (Tauri externalBin convention):

- `prometheus-server-x86_64-pc-windows-msvc.exe`
- `prometheus-server-x86_64-unknown-linux-gnu`
- `prometheus-server-aarch64-apple-darwin`
- `prometheus-server-x86_64-apple-darwin`

Do not commit real binaries.
