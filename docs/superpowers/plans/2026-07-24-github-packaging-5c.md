# 5C — GitHub Multi-platform Packaging

## Goal
Publish installable control-plane binaries and web assets via GitHub Actions.

## Delivered
- `.github/workflows/release.yml`
  - Windows x64, Linux x64, macOS arm64/x64 `prometheus-server` binaries
  - WebUI dist artifact
  - Tag-triggered GitHub Release upload
- Docker runtime image now packages Rust control plane + built WebUI

## Verify
```powershell
# local binary
cargo build --release --manifest-path apps/server-rs/Cargo.toml
# docker
docker build -t prometheus .
```

## Verification (2026-07-24)
- `cargo test --manifest-path apps/server-rs/Cargo.toml` green
- `cargo clippy --manifest-path apps/server-rs/Cargo.toml -- -D warnings` green
- protocol/client vitest + client typecheck green
- Client Runtime modal now lists skills and manages MCP servers
- MCP connect failures emit durable `system.notice`
