# 4F — Rust Git Worktree Team Runtime

## Goal
Port Node 3C worktree isolation into `apps/server-rs` without switching the default product entry.

## Delivered
- `GitWorktreeManager` real git CLI: create / review / apply / cleanup
- Config: `worktree_root` + `PROMETHEUS_WORKTREE_ROOT`
- Team create validation: unique agent assignment, safe relative paths, cross-agent path non-overlap
- Task lifecycle: create isolated worktree → full tools on child workspace root → review/finalize
- Manual merge keeps durable `pending` patch; auto merge applies when clean
- Apply / discard HTTP routes (no longer 501)
- Events: `team.workspace.created|cleaned|discarded`, `team.changes.detected|applied|conflicted`
- Tests: `git_worktree_contract`, `team_worktree_contract`, residual API messages still 501

## Explicit non-goals
- Team messages bus / `delegate_team`
- Switching `pnpm dev` to Rust by default
- Multi-platform packaging matrix
- Auto 3-way merge / host absolute path leakage in public payloads

## Verify
```powershell
cargo test --manifest-path apps/server-rs/Cargo.toml
cargo clippy --manifest-path apps/server-rs/Cargo.toml -- -D warnings
```
