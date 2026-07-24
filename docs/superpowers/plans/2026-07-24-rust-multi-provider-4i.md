# 4I — Rust Multi-Provider Runtime

## Goal
Port Node multi-provider adapters into `apps/server-rs` agent runtime:
- `openai` → OpenAI Responses API
- `openai_compatible` → Chat Completions (existing)
- `anthropic` → Messages streaming API
- `gemini` → GenerateContent stream API

## Delivered
- `providers/openai_responses.rs`
- `providers/anthropic.rs`
- `providers/gemini.rs`
- shared `providers/util.rs`
- `ChatMessage` carries tool_name/is_error for provider continuation mapping
- Contract: `tests/multi_provider_contract.rs`

## Non-goals
- Switching default entry to Rust
- Skills/MCP/SSH/cron
- Packaging matrix

## Verify
```powershell
cargo test --manifest-path apps/server-rs/Cargo.toml
cargo clippy --manifest-path apps/server-rs/Cargo.toml -- -D warnings
```
