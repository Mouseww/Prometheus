# Prometheus Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-shaped vertical slice: a real workspace browser and durable session timeline shared live by multiple clients, packaged from one React codebase for Web and Tauri 2.

**Architecture:** A pnpm monorepo separates the versioned protocol, Fastify control plane, and React client. SQLite stores sessions and append-only events; WebSocket is an optimization over sequence-based catch-up. A filesystem service exposes only paths contained by the configured workspace root.

**Tech Stack:** Node.js 24, TypeScript 5.9, Fastify, built-in `node:sqlite`, Zod, React 19, Vite, Vitest, Tauri 2, Rust stable.

---

## File map

- `packages/protocol/src/index.ts`: shared wire schemas and inferred TypeScript types.
- `apps/server/src/database.ts`: schema migration and SQLite lifecycle.
- `apps/server/src/session-repository.ts`: durable session/event persistence only.
- `apps/server/src/workspace-service.ts`: safe real-filesystem tree traversal only.
- `apps/server/src/event-hub.ts`: in-process subscription fan-out only.
- `apps/server/src/app.ts`: HTTP/WebSocket composition root.
- `apps/client/src/api.ts`: typed HTTP/WebSocket transport.
- `apps/client/src/use-prometheus.ts`: client state synchronization.
- `apps/client/src/App.tsx`: application layout and interactions.
- `apps/client/src/styles.css`: visual system and responsive behavior.
- `apps/client/src-tauri/*`: Tauri 2 desktop/mobile packaging shell.

### Task 1: Protocol contract

- [x] Define Zod schemas for workspace nodes, sessions, session events, event creation, and WebSocket envelopes.
- [x] Add protocol tests proving invalid event types and malformed payloads are rejected.
- [x] Run `pnpm --filter @prometheus/protocol test`; expect all tests to pass.

### Task 2: Durable session repository

- [x] Create SQLite migrations for `sessions` and `session_events`, including unique `event_id` and ordered integer `sequence`.
- [x] Write repository tests for creation, ordered replay, and idempotent duplicate event submission.
- [x] Implement the minimum repository methods needed by the tests.
- [x] Run `pnpm --filter @prometheus/server test`; expect repository tests to pass.

### Task 3: Safe workspace tree

- [x] Write tests that enumerate real fixture files, omit ignored heavy directories, and reject `..` escape attempts.
- [x] Implement canonical root containment and bounded directory traversal.
- [x] Run the focused workspace tests; expect all tests to pass.

### Task 4: HTTP and WebSocket control plane

- [x] Expose health, workspace tree, session list/create, event replay/append endpoints.
- [x] Broadcast committed events only after SQLite insertion succeeds.
- [x] Support `afterSequence` catch-up so reconnect correctness does not depend on the socket buffer.
- [x] Add API and browser tests for two-client visibility and sequence ordering.

### Task 5: Cross-platform client

- [x] Build a responsive three-pane IDE shell with a real API-backed workspace tree, session rail, timeline, and composer.
- [x] Connect WebSocket updates and merge events by sequence without duplicates.
- [x] Provide explicit offline, connecting, empty, and error states; do not inject sample tasks or fake agents.
- [x] Add state and browser tests for initial load and remote event arrival.

### Task 6: Tauri 2 shell

- [x] Add minimal Tauri configuration pointing at the Vite dev server and production assets.
- [x] Keep native capabilities empty in Foundation except core window/runtime permissions.
- [x] Verify `pnpm --filter @prometheus/client build` and `cargo check --manifest-path apps/client/src-tauri/Cargo.toml`.

### Task 7: Integrated verification

- [x] Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- [x] Start the server and client, create a session in one browser, open a second browser, append an event, and verify it appears without refresh.
- [x] Confirm the workspace tree reflects the actual configured root and a traversal request is rejected.

## Self-review

- Spec coverage: Foundation covers real workspace browsing and cross-terminal continuation substrate. Provider execution, SubAgents, Skills/MCP, SSH and cron are intentionally separate testable phases documented in `docs/architecture.md`.
- Placeholder scan: no fake data or placeholder implementation is accepted as a completed step.
- Type consistency: wire field names are owned by `@prometheus/protocol`; server and client must import them rather than redeclare them.
