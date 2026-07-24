# 4H — Rust delegate_team

## Goal
Port Node primary-agent `delegate_team` tool into `apps/server-rs`, blocking until the nested team completes (Node `TeamRunService.start`).

## Delivered
- `TeamRunService::start` = create + `execute_team` + return final `TeamRun`
- `tools/delegate_team_tools.rs` with dynamic eligible-agent schema
- Primary agent tool assembly includes `delegate_team` when other agents exist
- Subagents still receive only workspace/message tools (no recursive delegate)
- Contract: `tests/delegate_team_contract.rs`

## Non-goals
- Switching default entry to Rust
- Packaging matrix
- Fire-and-forget GUI-only team launch changes (HTTP launch remains async)

## Verify
```powershell
cargo test --manifest-path apps/server-rs/Cargo.toml
cargo clippy --manifest-path apps/server-rs/Cargo.toml -- -D warnings
```
