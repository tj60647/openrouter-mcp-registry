# Changelog

## 2026-11-27 — People sign in; the chat is for them

TJ: "The demo should require workos, correct? Perhaps the mcp as well? The demo
should register like any other client", with a list of addresses he keeps, and
any model for those signed in.

No migration. New settings, without which production refuses every client
(apps/mcp) or the chat stays closed (apps/web): `WORKOS_CLIENT_ID`,
`WORKOS_API_KEY`, `WORKOS_REDIRECT_URI` and `ALLOWED_EMAILS` on apps/mcp;
`MCP_OAUTH_CLIENT_ID`, `CHAT_SESSION_SECRET` and the chat's own
`OPENROUTER_API_KEY` on apps/web.

### Behaviour changes

- **The authorization endpoint asks a person to sign in** with WorkOS AuthKit,
  and issues a code only for a verified address on `ALLOWED_EMAILS`. The code
  carries the person, sealed (encrypted) so the client cannot read it, so no
  database column was needed. Their tokens carry `person`, and the MCP endpoint,
  the chat and every refresh check it against the list again: taking an address
  off ends that person's access at once.
- **Every token says whom it speaks for.** `client_credentials` tokens carry
  `grant: client_credentials`. In production a token, code or refresh token with
  neither (issued before this change) is refused, so interactive clients sign in
  once more; a service client's old access token lapses within the hour and the
  next one it mints carries the claim.
- **Registering a service client needs `OAUTH_REGISTRATION_ACCESS_TOKEN`**, and
  is refused while it is unset: a service client never meets the sign-in.
  Interactive clients may still register freely.
- **The chat moved into the demo, which owns its model** (TJ: "the intention
  of the demo is to be a demo of the MCP … rework 38 so the demo owns its
  model"). apps/mcp's `/api/chat` is removed; the MCP server now pays only for
  its own sync and embeddings. The demo runs its model on its own
  `OPENROUTER_API_KEY` and calls the registry's tools through `/api/mcp` with
  the visitor's token, as Claude or Cursor would. Removes: apps/mcp
  `GET`/`POST /api/chat`, and apps/mcp's `ai` and `@ai-sdk/openai` dependencies.
- **The web demo is an ordinary client**: it signs the visitor in through
  apps/mcp (authorization code + PKCE, public client `MCP_OAUTH_CLIENT_ID`),
  keeps their tokens in an encrypted HttpOnly cookie, refreshes them, and uses
  them for every call to the registry. It no longer uses `MCP_CLIENT_ID` for
  the chat.

## 2026-07-30 — External review remediation

Fixes the defects raised in an external comparative review, plus six regressions
found by an adversarial review of those fixes. Test suite grew 193 → 598.

### Requires a migration

Run `pnpm db:migrate` **before** the new build serves traffic. See
[Run database migrations](README.md#4-run-database-migrations) for what breaks
in the window if the code lands first.

The migration adds `sync_history.status`, `finished_at` and `partial`, creates
the `rate_limits` table, and contains **one destructive statement**: it removes
legacy `sync_history` start markers that are paired with a completed row. It
snapshots the table into `sync_history_pre_lifecycle_backup` first and prints
what it touched. Drop that backup once you are satisfied with the result.

### Behaviour changes

- **`sync_history` is one row per attempt.** A sync used to write two: a start
  marker with `success: false` before contacting OpenRouter, then the real
  outcome. Half the table was noise and a genuine outage was indistinguishable
  from a start marker. The row is now opened as `status: "running"` with a null
  `success` and updated in place, so `success: false` always means a real
  failure and always carries an `error`. `syncedAt` is the start, `finishedAt`
  the end.
- **`/api/health` returns 503 on the failure path**, not 200. Monitors keyed on
  the status code previously reported the service healthy with a dead database.
  It also now returns the whole `SyncStatus` record rather than two of its four
  fields, which is why `/sync-status` could never display an error.
- **`fields` rejects unknown names.** Previously `z.array(z.string())` with
  unrecognised names dropped silently, so a typo returned a successful response
  with the datum missing. Now a validation error.
- **Retirement is swept globally.** The sweep ran per provider over only the
  providers present in the response, so a provider vanishing from the catalogue
  entirely was never swept — its models stayed available forever. Guarded by
  volume: a response holding under 80% of the previous sync's count skips the
  sweep and records `partial: true`.
- **Rate limits are durable.** Counters moved from per-process memory to
  Postgres, so a limit holds across serverless instances instead of per warm
  lambda. `/api/mcp` tool calls and `/api/admin/verify-login` are now limited at
  all; neither was before.

### Fixed

- Dynamic client registration's open-by-default stance is documented in code as
  a decision, with the bounds that make it defensible — including the per-client
  tool budgets that previously did not exist.
- Deleted `apps/mcp/src/lib/mcpServer.ts`, an unreferenced duplicate of
  `mcp-server.ts` extracted twice on the same day by two branches.
- Lint had never successfully run in `packages/shared` (no config) or `apps/mcp`
  (`next lint` stopped at its setup prompt). Both fixed and moved off the
  deprecated `next lint`.
- `tsconfig.base.json`'s root-relative `outDir` made both apps write the same
  `tsbuildinfo`, each invalidating the other's incremental cache.
- Removed the stray `package-lock.json`; the repo is pnpm, now pinned via
  `packageManager`.

### Added

- CI (`.github/workflows/ci.yml`): lint → typecheck → test → build on every PR
  and push to `main`. The `verify` job is a required status check.
- Coverage reporting with per-workspace thresholds, enforced by
  `pnpm test:coverage`.
