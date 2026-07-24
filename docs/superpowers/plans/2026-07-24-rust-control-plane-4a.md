# Rust Control Plane 4A Implementation Plan

> **For agentic workers:** Execute task-by-task with checkbox (`- [ ]`) tracking. Do not switch production/default startup away from the Node control plane until the compatibility gates in Task 6 pass. Do not commit or push unless the user explicitly requests it.

**Goal:** 新增一个真实可运行的 Rust Control Plane 兼容纵切，在不修改 React/Tauri 前端的前提下复用现有 HTTP、WebSocket、SQLite 和 protocol v0.8 合同，并为后续 Provider/Tool/Team Runtime 等价迁移建立稳定边界。

**Architecture:** `apps/server-rs` 使用 Axum/Tokio 承载 HTTP 与 WebSocket，SQLx 直接访问与 Node 后端兼容的 SQLite schema。Repository、workspace boundary、event broadcast 和 transport 分开；Rust 服务只声明已完成并通过契约测试的能力。Node 服务继续作为完整运行时基线，直到 Agent/Tool/Team parity 全部迁移完成。

**Tech Stack:** Rust 1.93、Axum、Tokio、SQLx SQLite、Tower HTTP、Serde、UUID、Chrono、AES-256-GCM、现有 React/Tauri 前端与 Playwright E2E。

---

## File map

- `apps/server-rs/Cargo.toml`: 独立 Rust 服务依赖和 binary/library targets。
- `apps/server-rs/src/config.rs`: 环境变量、workspace/data/web roots 与监听地址解析。
- `apps/server-rs/src/error.rs`: 与现有 `{ error, message }` 响应兼容的统一错误映射。
- `apps/server-rs/src/models.rs`: protocol v0.8 当前纵切需要的 Rust DTO；JSON 字段名保持 camelCase。
- `apps/server-rs/src/database.rs`: 与 Node `database.ts` 相同的 SQLite 表和幂等列迁移。
- `apps/server-rs/src/session_repository.rs`: Session/Event 持久化、eventId 幂等和 sequence 重放。
- `apps/server-rs/src/workspace.rs`: canonical root、目录浏览、忽略目录、符号链接和越界保护。
- `apps/server-rs/src/event_hub.rs`: session-scoped broadcast；durable SQLite 仍是真相源。
- `apps/server-rs/src/config_repository.rs`: Provider、Agent、Permission Rule 的真实 SQLite CRUD 和密钥加密。
- `apps/server-rs/src/app.rs`: Axum Router、CORS、静态 SPA、REST 与 WebSocket transport。
- `apps/server-rs/src/lib.rs`: 可测试的 app construction API。
- `apps/server-rs/src/main.rs`: 运行时装配和 graceful shutdown。
- `apps/server-rs/tests/api_contract.rs`: 通过公开 HTTP/WebSocket 接口验证前端 bootstrap、session/event 和配置合同。
- `scripts/e2e_rust_foundation.py`: 不改前端的双浏览器 Rust Control Plane E2E。
- `.github/workflows/build.yml`: parity 完成后再增加 Windows/macOS/Linux/Tauri Android/iOS 构建矩阵；4A 不提前发布不完整安装包。

### Task 1: Runnable Rust service boundary

- [x] RED: 创建 contract test，向空 Router 请求 `GET /api/health`，预期当前 404 而目标为 200、`status=ok`、真实 workspace 名称和 ISO timestamp。
- [x] GREEN: 建立 `Config`、`AppState` 和 `build_router`；health handler 从 canonical workspace root 返回实际名称，不使用固定 demo workspace。
- [x] VERIFY: `cargo test --manifest-path apps/server-rs/Cargo.toml health_contract -- --exact` 通过；`cargo clippy --manifest-path apps/server-rs/Cargo.toml -- -D warnings` 通过。

### Task 2: SQLite-compatible durable sessions

- [x] RED→GREEN: HTTP contract 创建 session，验证 201、UUID、idle、sequence 0；重新构建 AppState 打开同一数据库后 `GET /api/sessions` 仍能读取。
- [x] RED→GREEN: append event 验证 201、单调 sequence、同 eventId 同内容幂等；同 eventId 不同内容返回 409 `event_conflict`；缺失 session 返回 404。
- [x] GREEN: SQLx migration 使用与 Node 相同的表名/列名/index，并保留 3C `workspace_mode`、`merge_strategy` 和 task change metadata 列。

### Task 3: Workspace browser and unchanged frontend bootstrap

- [x] RED→GREEN: `GET /api/workspace` 返回目录优先、大小写不敏感排序和 `/` 相对路径；忽略 `.git/.prometheus/coverage/dist/node_modules/target` 与符号链接。
- [x] RED→GREEN: `..`、绝对路径和 symlink escape 返回 403 `workspace_boundary`；不存在路径返回 404 `path_not_found`。
- [x] GREEN: `GET /api/providers`、`GET /api/agents`、`GET /api/permission-rules` 从真实 SQLite 返回集合，使现有前端 `Promise.all` bootstrap 不需要条件分支。

### Task 4: Durable realtime sync

- [x] RED→GREEN: WebSocket `/ws?sessionId=...&afterSequence=N` 首帧发送 durable `sync`；后续 HTTP append 的 event 通过 broadcast 发送 `event` envelope。
- [x] RED→GREEN: 非法 UUID/缺失 session 发送 protocol error envelope 并以 policy violation 关闭；lagged receiver 从 SQLite 重查，不把 broadcast 当真相源。
- [x] VERIFY: 双客户端测试断开后按 `afterSequence` 补齐，不要求 WebSocket exactly-once。

### Task 5: Real configuration persistence

- [x] RED→GREEN: Provider create/list/update 保持现有 status code、字段名和 OpenAI-compatible base URL 校验；API 响应只返回 `hasApiKey`。
- [x] RED→GREEN: Rust AES-256-GCM envelope 与 Node `v1:iv:tag:ciphertext` base64url 格式双向兼容；主密钥必须为 32 bytes。
- [x] RED→GREEN: Agent create/update 校验 Provider 外键，缺失引用返回 422；Permission Rule create/list/delete 保持 deny→ask→allow 排序和 404 行为。

### Task 6: Compatibility gate before runtime migration

- [x] Rust 托管 SPA：ServeDir + index.html fallback；contract 覆盖 `/` 与静态资源。
- [x] 对同一临时 SQLite 文件分别运行 Node 与 Rust HTTP contract（scripts/run_cross_runtime_sqlite.py），证明 session/event/config 互读。
- [x] cargo test + cargo clippy -D warnings 已绿；cargo fmt --check 与全仓 pnpm/Tauri 仍可按需复跑。
- [x] 未迁移 runs/approval/team/worktree API 返回 501 runtime_not_migrated；README 标明 Rust 4A 为兼容预览，默认仍为 Node。
- [x] 双浏览器 foundation E2E 对着 Rust Control Plane（scripts/run_e2e_rust_foundation.py）：workspace/session/event/config/reload。

### Task 7: Later GitHub multi-platform packaging gate

- [ ] 只有 Rust Agent/Tool/Team parity 和现有 E2E 全部通过后，才修改 `.github/workflows/build.yml` 增加 Windows x64/arm64、macOS Intel/Apple Silicon、Linux x64/arm64 和 Tauri Android/iOS matrix。
- [ ] Windows Authenticode、macOS Developer ID/notarization、Android keystore 与 iOS signing secrets 只通过 GitHub Environments/Secrets 注入；fork/PR 不获得发布权限。
- [ ] tag workflow 上传 checksum、SBOM、签名状态和平台安装包；缺失签名材料时只生成明确标记的 unsigned CI artifact，不创建正式 Release。

## Explicit non-goals for 4A

- 不删除 Node 后端，不切换 `pnpm dev`、Docker 或正式安装包默认入口。
- 不在 4A 重写 Provider streaming、Agent loop、工具审批、Shell、Team Runtime 或 Git worktree；这些按后续 parity 纵切逐个迁移。
- 不复制 TypeScript protocol 逻辑后静默漂移；Rust DTO 由 HTTP/WebSocket compatibility tests 约束。
- 不为了展示 GitHub workflow 而发布缺功能、未签名或无法运行的安装包。




