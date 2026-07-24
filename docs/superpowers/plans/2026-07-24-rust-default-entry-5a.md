# 5A — Default Entry Switches to Rust Control Plane

## Goal
Make `apps/server-rs` the default development Control Plane while keeping Node as an explicit fallback.

## Delivered
- `pnpm dev` starts Rust server + Vite client
- `pnpm dev:node` keeps Node control plane path
- `pnpm dev:server-rs` / `pnpm start:server-rs` for Rust-only
- `pnpm test:server-rs` for cargo tests
- README default-entry update

## Non-goals
- Removing Node server
- Skills/MCP (next slice)
- Multi-platform installers (later)

## Verify
```powershell
pnpm dev:server-rs
# health
# GET http://127.0.0.1:4310/api/health
cargo test --manifest-path apps/server-rs/Cargo.toml
```
