# Connectors plugin design

Let the agent use third-party services (GitHub, Jira/Confluence, Bitbucket, Microsoft 365's Outlook/Teams/OneDrive, databases, etc.) securely through "connectors". The user authorizes accounts in **Settings → Connectors**, and the agent calls the authorized services through a small set of generic tools.

## 1. Goals and non-goals

Goals

- A unified "Provider" abstraction: declare an auth method plus a set of operations tagged read/write.
- Multiple authorization flows: OAuth2 authorization code + PKCE (local callback), OAuth2 device code (no browser / remote server scenarios), personal access token / API token / Basic auth, connection strings.
- Credentials encrypted at rest, never entering the model context, logs or RPC return values.
- Write operations controlled by default: each connection can be set to "read-only / confirm writes / allow writes".
- Adding a new service means adding one provider file, without touching tools or UI.

Non-goals

- Reimplementing MCP. Services that already have an MCP server keep using MCP; connectors target cases that need unified authorization management with no existing MCP.
- No webhooks/event subscriptions in the first version.

## 2. Architecture

```
Settings → Connectors (ConnectorsView)
        │ plugin.call(connectors.*)
        ▼
plugins/connectors
  registry  ── provider catalog (github / atlassian / bitbucket / microsoft / database)
  vault     ── AES-256-GCM encrypted connection records (<dataDir>/vault.json + vault.key, both 0600)
  oauth     ── PKCE authorization code, device code, refresh, concurrency-safe token refresh
  tools     ── connector_list / connector_describe / connector_call
  routes    ── GET /plugins/connectors/oauth/callback
```

### Agent tools (deliberately only 3, to avoid blowing up the context)

| Tool | Purpose |
|------|---------|
| `connector_list` | List connected accounts (id, provider, permission policy); contains no credentials |
| `connector_describe` | Show a provider's operation list and parameter schemas |
| `connector_call` | `{ connection, operation, params }` — execute an operation, truncating the result to a limit |

The prompt injects only one line — "Connected: github(work), jira(acme)" — and detailed schemas are fetched on demand via describe.

### Permission model

Every operation carries `access: "read" | "write"`. Every connection has a `policy`:

- `read-only`: write operations are refused outright;
- `confirm` (default): write operations ask the user via `ctx.ui.confirm`; refused when there is no UI (unattended automation);
- `allow`: executed directly.

Database providers additionally validate SQL for read-only access (under the read-only policy, only a single SELECT/WITH/EXPLAIN/SHOW/PRAGMA read statement is allowed).

### Credential security

- Credentials are stored only as ciphertext in the vault; the `list` RPC returns a redacted view (`hasSecret`, expiry).
- The master key is a random 32-byte file with 0600 permissions. This prevents plaintext leakage through backups or accidental commits, but it **cannot** defend against a malicious process running as the same user on the same machine; for stronger guarantees, integrate the system keychain (see §6).
- Outgoing HTTP to third parties uses https only (except databases), with enforced timeouts and response size limits.
- OAuth `state` is single-use and expires in 10 minutes; the callback is only available while listening on the local machine.

### OAuth strategy

- Device code first (GitHub, Microsoft): no callback URL needed, works for web/Android/remote servers.
- Authorization code + PKCE (Atlassian, Bitbucket, optionally Microsoft): callbacks to `/plugins/connectors/oauth/callback`.
- Client ID/Secret are filled in by the user in connector settings (each platform requires registering your own OAuth app); nothing is bundled.

## 3. Data model

```ts
interface ConnectionRecord {
  id: string; provider: string; label: string;
  policy: "read-only" | "confirm" | "allow";
  config: Record<string, string>;        // non-secret: site domain, workspace, host, etc.
  secret: string;                        // ciphertext (JSON): token / refresh / client secret / password
  expiresAt?: number; createdAt: string;
}
```

## 4. Adding a provider

Implement `ConnectorProvider` (`src/types.ts`) and register it in `src/providers/index.ts`: declare `auth`, `fields` and `operations`, and implement `test()`.

## 5. Built-in providers (first version)

- GitHub: repos / issues / PRs / code search / create issue / comment
- Atlassian: Jira search/view/create/comment/transition; Confluence search/read page
- Bitbucket: repo/PR/issue listing, PR comments
- Microsoft 365: Outlook mail list/read/send, calendar, Teams teams/channels/send message, OneDrive search
- Database: PostgreSQL (optional dependency `pg`), SQLite (`node:sqlite`), schema inspection and queries

## 6. Future work

System keychain, webhooks, MySQL/MSSQL, connection health checks and expiry reminders, per-operation allow lists.
