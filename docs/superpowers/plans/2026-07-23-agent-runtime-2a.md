# Agent Runtime 2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure encrypted multi-provider credentials and agent profiles from the GUI, invoke a real remote model, and persist the complete reply into the shared session timeline.

**Architecture:** A provider-neutral package wraps official SDKs. The server stores provider metadata and AES-GCM encrypted secrets, while `AgentRunService` reconstructs durable session history and records run boundaries. The React client exposes real configuration forms and only enables execution when a valid agent is selected.

**Tech Stack:** TypeScript, Zod, Node crypto, SQLite, OpenAI SDK, Anthropic SDK, Google Gen AI SDK, Fastify, React, Vitest.

---

### Task 1: Protocol resources

**Files:** `packages/protocol/src/index.ts`, `packages/protocol/src/index.test.ts`

- [x] Define `Provider`, `AgentProfile`, create/update inputs, run input/result, and new durable event types.
- [x] Test that secrets are accepted in write schemas but impossible in provider response schemas.
- [x] Run `pnpm --filter @prometheus/protocol test`; expect schema tests to pass.

### Task 2: Encrypted configuration persistence

**Files:** `apps/server/src/secret-vault.ts`, `provider-repository.ts`, `agent-repository.ts`, `database.ts`

- [x] Write failing tests for AES-GCM round-trip, tamper rejection, and unique ciphertext.
- [x] Implement `SecretVault` with a 32-byte key and versioned envelope.
- [x] Add provider and agent migrations and repository tests.
- [x] Ensure repository read models expose only `hasApiKey`.

### Task 3: Provider-neutral runtime

**Files:** `packages/agent-core/src/*`

- [x] Define normalized messages, usage, request, response, and `ModelProvider`.
- [x] Implement OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, and Gemini GenerateContent adapters with official SDKs.
- [x] Use injected SDK clients in tests to assert request mapping without external credentials.
- [x] Reject empty provider responses instead of manufacturing assistant text.

### Task 4: Durable run orchestration

**Files:** `apps/server/src/agent-run-service.ts`, `app.ts`

- [x] Test success, missing credentials, provider failure, and history reconstruction.
- [x] Persist `agent.run.started` before network I/O.
- [x] Persist `message.agent` and `agent.run.completed` only after a non-empty response.
- [x] Persist a sanitized `agent.run.failed` on failure.
- [x] Expose resource-oriented Provider, Agent, and Run endpoints.
- [x] Return `422 configuration_reference_not_found` before SQLite writes when an Agent references a missing Provider.

### Task 5: Real configuration and execution UI

**Files:** `apps/client/src/api.ts`, `use-prometheus.ts`, `App.tsx`, `styles.css`

- [x] Add provider form fields for kind, name, base URL, model, and API key.
- [x] Add agent form fields for name, description, system prompt, provider, and model.
- [x] Show configured providers/agents from API data only.
- [x] Send the user event first, then start a run with the selected agent.
- [x] Display running and failure states from durable events.

### Task 6: Verification

- [x] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and Tauri `cargo check`.
- [x] Browser-test provider/agent configuration with a local protocol fixture server; verify no fixed product response exists.
- [x] Check for real provider credentials. None were present, so no paid live call was executed.

Verification on 2026-07-23: 24 tests passed; repository-wide typecheck and production build passed; Tauri `cargo check` passed; the three-service browser E2E confirmed encrypted configuration, Agent creation, an actual OpenAI-compatible SDK request, and four durable timeline events.

## Self-review

- Phase 2A deliberately excludes tool execution and SubAgents; the UI must not label them connected.
- Runtime package has no persistence or UI dependencies.
- Provider secrets never appear in read schemas, logs, session events, or error responses.
- SDK tests validate protocol mapping; product code contains no demo provider or fallback assistant response.
