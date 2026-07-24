# 5B — Skills & MCP Runtime

## Goal
Ship a real Skills + MCP extension surface on the Rust control plane.

## Delivered
- Workspace skill discovery from `.prometheus/skills/*/SKILL.md` and `skills/*/SKILL.md`
- `GET /api/skills`
- `read_skill` tool + system-prompt skill catalog injection
- MCP server CRUD (`/api/mcp-servers`)
- Stdio MCP client (initialize / tools/list / tools/call)
- MCP tools exposed as `mcp__{server}__{tool}` with permission-target evaluation
- Contract tests with skill fixture + Python MCP echo server

## Non-goals
- MCP SSE/HTTP transports
- Skill marketplace
- Long-lived MCP process pool across control-plane restarts

## Verification (2026-07-24)
- `cargo test --manifest-path apps/server-rs/Cargo.toml` green
- `cargo clippy --manifest-path apps/server-rs/Cargo.toml -- -D warnings` green
- protocol/client vitest + client typecheck green
- Client Runtime modal now lists skills and manages MCP servers
- MCP connect failures emit durable `system.notice`
