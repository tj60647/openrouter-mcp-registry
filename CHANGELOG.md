# Changelog

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
