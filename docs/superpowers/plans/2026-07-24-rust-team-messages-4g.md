# 4G — Rust Team Messages Bus

## Goal
Port Node team message bus into `apps/server-rs` for durable subagent communication.

## Delivered
- `team_messages` repository: append / list / list_visible_to
- `TeamMessageService.send` publishes durable `agent.message`
- HTTP `GET /api/team-runs/:teamRunId/messages?afterSequence=`
- Subagent tools: `send_team_message`, `read_team_messages` (optional waitMs)
- Channel normalization matches Node (`*` => shared, non-broadcast shared => direct)
- Contracts: team_messages_contract + residual route updates

## Non-goals
- `delegate_team` primary-agent tool
- Switching default entry to Rust
- Packaging matrix

## Verify
```powershell
cargo test --manifest-path apps/server-rs/Cargo.toml
cargo clippy --manifest-path apps/server-rs/Cargo.toml -- -D warnings
```
