# OpenRouter Registry MCP

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/tj60647/openrouter-mcp-registry)

A production-ready monorepo that provides a **centralized MCP model registry** backed by OpenRouter, plus a **browsable reference web application**. Designed for zero-config deployment on Vercel.

> **What `apps/web` is:** A human-facing demo that includes a live chatbot (`/demo`) powered by the MCP. The chatbot posts to an `apps/web` server route, which calls `apps/mcp` with server-side MCP client credentials; `apps/mcp` discovers/executes registry tools and owns the OpenRouter call. Browser-facing model/resolve pages call `apps/web` route handlers that proxy to `apps/mcp`; `apps/web` does not own OpenRouter or Neon runtime access; it uses `apps/mcp` for chat, admin credential verification, model resolution, registry reads, sync, and embeddings. Only local/CI scripts in the web workspace need `POSTGRES_URL`. For external MCP client setup (Claude Desktop, Copilot, Codex), see [MCP Client Setup](#mcp-client-setup).

## Why?

AI coding assistants and agents that call LLM APIs directly suffer from:

- **Stale model names** — providers rename, deprecate, or remove models without notice
- **No abstraction** — every client hardcodes its own model IDs
- **No catalog** — no single source of truth for what models exist and what they cost

This registry solves all three problems:

- Fetches the live model catalog from OpenRouter daily (and on-demand)
- Normalizes model IDs to a canonical form across providers
- Serves an MCP-compatible endpoint that AI clients can query

---

## Architecture

```mermaid
graph TD
    shared["packages/shared\nTypes · Services"]

    subgraph mcp_deploy["Vercel Project · apps/mcp  ← deploy this first"]
        mcpApp["apps/mcp\nNext.js · MCP + REST API"]
        db[("Neon Postgres\nmodels · sync_status")]
        cron["Cron (daily)\nvia apps/mcp/vercel.json"]
    end

    subgraph web_deploy["Vercel Project · apps/web  ← optional demo UI (MCP client + admin UI)"]
        webApp["apps/web\nNext.js · Demo UI + MCP client chatbot"]
    end

    openrouter["OpenRouter API"]

    shared -.->|shared code| mcpApp
    shared -.->|shared code| webApp
    mcpApp --> db
    webApp -->|MCP Streamable HTTP /api/mcp| mcpApp
    webApp -->|server-side proxy with MCP client credentials| mcpApp
    cron -->|daily sync| openrouter
```

### Monorepo layout

```
openrouter-mcp-registry/
├── apps/
│   ├── mcp/              Next.js app — MCP server + full REST API  ← primary
│   │   └── vercel.json   Vercel cron config for this project
│   └── web/              Next.js app — Demo UI + MCP-client chatbot ← optional
├── packages/
│   └── shared/           Shared TypeScript — types, services, providers
├── vercel.json           Root Vercel metadata; cron lives in apps/mcp/vercel.json
└── pnpm-workspace.yaml
```

### Two-host layout

The two apps deploy to **two different origins**, and it matters which one you hand to an MCP client:

| Host                          | Serves                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| **API host** (`apps/mcp`)     | `/api/mcp`, `/api/oauth/*`, `/.well-known/*`, `/api/cron/sync`, the REST API                |
| **Docs host** (`apps/web`)    | `/mcp-info` (the integration reference), `/models`, `/demo`, `/admin`                        |

Each host redirects the other's paths instead of returning `404`, so a client handed the wrong URL still works:

- `apps/web` → when `NEXT_PUBLIC_MCP_URL` is set, it **308**-redirects `/api/mcp`, `/api/mcp/*`, `/api/oauth/*` and all of `/.well-known/*` to the API host. `308` preserves the request method and body, so a JSON-RPC `POST /api/mcp` and a form-encoded `POST /api/oauth/token` survive the hop — the client must follow redirects.
- `apps/mcp` → when `NEXT_PUBLIC_WEB_URL` is set, it 308-redirects `/mcp-info` to the docs host.

Both redirect sets live in the apps' `next.config.ts`, are emitted only when the corresponding env var is set (single-host local dev emits none), and are baked in at build time — changing the variable on an existing deployment requires a redeploy. Point clients at the API host directly to avoid the extra round trip.

---

## REST API

Both apps expose REST routes, but **`apps/mcp`** is the canonical backend and runtime owner of OpenRouter, Neon/Postgres, registry data, provider/model resolution, embeddings, sync jobs, MCP auth validation, admin mutations, and cron endpoints. **`apps/web`** exposes browser-facing route handlers that proxy to `apps/mcp` and stores only optional web-owned admin session cookies; it does not require `OPENROUTER_API_KEY` or `POSTGRES_URL` at Vercel runtime.

### `apps/mcp` routes (full API)

| Method | Path                     | Description                                                     |
| ------ | ------------------------ | --------------------------------------------------------------- |
| `GET`  | `/api/models`            | List cached models (`?limit`, `?offset`, `?provider`, `?query`) |
| `GET`  | `/api/models/:id`        | Get model by canonical ID                                       |
| `POST` | `/api/resolve`           | Resolve model ID → canonical model                              |
| `GET`  | `/api/health`            | Health check plus the full `SyncStatus` record (`lastSuccessfulSync`, `lastAttemptedSync`, `lastError`, `recordCount`); `null` when no sync has been recorded. `200` when healthy, `503` when the registry is unreachable |
| `POST` | `/api/admin/refresh`     | Trigger manual sync (requires `ADMIN_SECRET`)                   |
| `POST` | `/api/admin/verify-login`| Verify admin credentials for web-owned sessions (requires MCP OAuth when configured). Rate limited 10 attempts / 15 min per username *and* source address — per-username alone would let anyone lock an admin out — `429` beyond that |
| `GET`  | `/api/admin/sync-status` | Full sync status (requires `ADMIN_SECRET`)                      |
| `GET`  | `/api/admin/clients`     | List registered OAuth clients (requires `ADMIN_SECRET`)         |
| `POST` | `/api/admin/clients/revoke` | Revoke or restore an OAuth client (requires `ADMIN_SECRET`)  |
| `GET`  | `/api/admin/usage`       | MCP usage aggregated by client and tool (requires `ADMIN_SECRET`) |
| `GET`  | `/api/cron/sync`         | Daily cron sync (protected by `CRON_SECRET`)                    |
| `POST` | `/api/mcp`               | MCP Streamable HTTP endpoint (OAuth 2.1 protected in production) |
| `GET`  | `/api/oauth/authorize`   | OAuth 2.1 authorization endpoint (authorization code + PKCE, auto-approved) |
| `POST` | `/api/oauth/token`       | OAuth token endpoint (`authorization_code`, `refresh_token`, `client_credentials`) |
| `POST` | `/api/oauth/register`    | OAuth dynamic client registration (RFC 7591); honours and echoes `grant_types` |
| `GET`  | `/api/oauth/register/{client_id}` | Read a client's own registration (RFC 7592; bearer `registration_access_token`) |
| `DELETE` | `/api/oauth/register/{client_id}` | Delete (revoke) a client's own registration; returns `204` |
| `GET`  | `/.well-known/oauth-authorization-server` | OAuth Authorization Server metadata (RFC 8414) |
| `GET`  | `/.well-known/oauth-protected-resource` | OAuth Protected Resource metadata (RFC 9728)  |
| `GET`/`POST` | `/api/chat`        | MCP-owned demo chat endpoint; owns OpenRouter call and registry tool execution |

### `apps/web` routes (demo UI)

| Method | Path                 | Description                                                                                                                                              |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/models`        | List cached models (`?limit`, `?offset`, `?provider`, `?query`, `?sortBy`, `?sortDir`, `?toolsOnly`, `?reasoningOnly`, `?availableOnly`, `?retiredOnly`) |
| `GET`  | `/api/providers`     | List distinct provider names                                                                                                                             |
| `POST` | `/api/resolve`       | Resolve model ID → canonical model                                                                                                                       |
| `GET`  | `/api/health`        | Health check. Proxies the MCP host and passes its status through; `503` when that host is unreachable                                                     |
| `GET`  | `/api/chat`          | Agent config — default model, available models, and MCP tools list                                                                                       |
| `POST` | `/api/chat`          | Chatbot proxy — browser posts here; server-side route delegates LLM + tool calls to `apps/mcp`                                                           |
| `POST` | `/api/admin/login`   | Create a web-owned admin session after server-side credential verification by apps/mcp; issues session cookie                                                                                        |
| `POST` | `/api/admin/logout`  | Clear admin session cookie                                                                                                                               |
| `GET`  | `/api/admin/session` | Current signed-in admin identity (session-gated)                                                                                                         |
| `GET`  | `/api/admin/clients` | Admin panel: list OAuth clients (proxies to `apps/mcp`, session-gated)                                                                                   |
| `POST` | `/api/admin/clients/revoke` | Admin panel: revoke/restore an OAuth client (proxies to `apps/mcp`, session-gated)                                                                |
| `GET`  | `/api/admin/usage`   | Admin panel: MCP usage by client and tool (proxies to `apps/mcp`, session-gated)                                                                         |
| `POST` | `/api/admin/refresh` | Removed from web runtime; admin sync is owned by `apps/mcp`                                                                                              |
| `GET`  | `/api/cron/sync`     | Removed from web runtime; cron sync is owned by `apps/mcp`                                                                                               |

## MCP Capabilities

Connect any MCP-compatible client to `POST /api/mcp`. The server exposes **tools**, **resources**, and **prompts**.

### Tools

| Tool                      | Description                                     | Parameters                                                                                                                                         | Returns                              |
| ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `list_models`             | List all registry models                        | `limit` (**omit for all records**), `offset`, `provider`, `query`, `sortBy`, `sortDir`, `availableOnly`, `verbose`, `fields`                        | `{ models, count, total }`           |
| `resolve_model`           | Resolve and look up a model by ID               | `input: string`                                                                                                                                      | full record                          |
| `get_model`               | Get full details for a model                    | `id: string`                                                                                                                                         | full record                          |
| `search_models`           | Search by name, ID, or provider                 | `query: string`, `limit` (default 20, max 100), `offset`, `sortBy`, `sortDir`, `verbose`, `fields`                                                   | `{ models, count, total }`           |
| `find_models_by_criteria` | Filter by budget, context, and modality         | `maxInputPricePer1k`, `maxOutputPricePer1k`, `minContextLength`, `modality`, `limit` (default 50, max 200), `offset`, `sortBy`, `sortDir`, `verbose`, `fields` | `{ models, count, total }`  |
| `compare_models`          | Compare 2–5 models side-by-side                 | `ids: string[]`                                                                                                                                      | `{ comparison }`                     |
| `semantic_search`         | Find models by natural language similarity      | `query: string`, `limit` (default 10, max 50), `offset`, `verbose`, `fields`                                                                         | `{ models, count }` (no `total`)     |
| `get_registry_status`     | Current sync state + live row counts            | —                                                                                                                                                    | `{ status }` (see below)             |
| `get_sync_history`        | Recent sync attempts with success/error details | `limit` (default 50, max 200)                                                                                                                        | `{ history, count }`                 |

Argument conventions:

- Filter arguments and returned record fields are **camelCase** (`maxInputPricePer1k`, `availableOnly`, `contextLength`). `sortBy` is the one exception: it accepts **both** snake_case and camelCase spellings for the same column (`created_at` ≡ `createdAt`, `input_price_per_1k` ≡ `inputPricePer1k`, and so on for `display_name`, `context_length`, `max_completion_tokens`, `output_price_per_1k`, `image_price_per_1k`). Default `id`.
- `verbose` (boolean, default `false`) omits `description` and `metadata` from every returned record — they dominate payload size. Pass `verbose: true` to get them back.
- `fields` (string array) is an explicit projection using camelCase `Model` field names. It wins over `verbose` and always includes `id`. Only the documented `Model` field names are accepted — an unrecognised one is a validation error, not a silently missing field. Unlike `sortBy`, `fields` takes camelCase only.
- `verbose`/`fields` apply only to `list_models`, `search_models`, `find_models_by_criteria` and `semantic_search`. `get_model`, `resolve_model`, `compare_models` and the `registry://` resources always return full records.
- Prices are **USD per 1,000 tokens** throughout.
- `modality` is matched as a case-insensitive substring of OpenRouter's whole `inputs->outputs` string. To find vision models match the **input** side (`image->`); `text->image` is an image *generator*.

Reconciling counts:

- `count` = records in **this page** (affected by `limit`/`offset`).
- `total` = records matching the filter/search/criteria, **ignoring** `limit`/`offset`.
- `get_registry_status` returns `{ lastSuccessfulSync, lastAttemptedSync, lastError, recordCount, totalCount, availableCount, retiredCount }`. `recordCount` is how many models OpenRouter returned in the last **successful** sync; `totalCount` is the live row count and therefore **includes retired models**, with `totalCount = availableCount + retiredCount`.
- `list_models` returning a larger `total` than `recordCount` is expected: `availableOnly` defaults to `false`, so retired rows are included.

Model lifecycle semantics:

- `isAvailable` is the **authoritative** flag and the only field the query layer filters on (`availableOnly: true` → `is_available = TRUE`). `true` means the model was present in the latest OpenRouter sync; `false` means it was absent, which is inferred from sync absence and is not always a provider-declared retirement notice.
- `retiredAt` is a timestamp annotation only, never a filter. It records when the **current** retirement episode began; if a model reappears the upsert resets it to `null`, so it is not a "was ever retired" history.
- `lastSeenAt` is the most recent successful sync where the model was still present. It is written from the same timestamp as `fetchedAt`, so for any row a sync touches the two are identical; for a retired model both freeze at the last sync where the model was present.
- `isAvailable` and `retiredAt` cannot disagree: both writers set them together inside one transaction, which rolls back as a unit on failure.
- `providerExpirationAt` is the scheduled provider expiry date from OpenRouter when available — independent of the three fields above.

Notes:

- The web UI now uses the term "Unavailable" instead of "Retired" because sync absence and provider-declared expiry are distinct states.
- The `compare_models` MCP tool includes lifecycle fields such as `providerExpirationAt`, `lastSeenAt`, `retiredAt`, and `isAvailable` in its response.
- The retirement sweep in `db.ts::upsertModels` is a single global `UPDATE` over every row the current sync did not touch, so a provider disappearing from OpenRouter's catalogue entirely is retired like any other absence. (It previously ran per provider, over only the providers present in the response, which by construction could never see a provider that had gone.)
- The sweep is guarded by **volume**: if a sync fetches fewer than 80% of the models currently marked available, the sweep is skipped and the run is recorded with `partial: true` in `sync_history` and in the `/api/cron/sync` response. The catalogue still updates; only retirement waits for a sync that looks whole. Consecutive `partial` runs mean retirement data is going stale.
- A small number of rows retired before the `retired_at` column existed had it backfilled to equal `fetched_at`, so for those `retiredAt` is the last sync the model *was* present rather than the first sync it was missing. They are identifiable by `retiredAt === lastSeenAt`.

### Resources

Read-only data accessible via `resources/read`:

| URI                      | Description                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `registry://models`      | Full model list (every record, unfiltered, includes retired models)                                       |
| `registry://status`      | Sync status (`lastSuccessfulSync`, `lastAttemptedSync`, `lastError`, `recordCount`) — no live counts   |
| `registry://models/{id}` | Details for a specific model (URL-encode the ID)                                                       |

Resources are never projected: they always return full records including `description` and `metadata`.

### Prompts

Reusable reasoning templates accessible via `prompts/get`:

| Prompt                  | Description                         | Parameters                                                             |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `select_model`          | Guide model selection for a task    | `task_description`, `budget_usd_per_1k_tokens?`, `min_context_length?` |
| `compare_models_prompt` | Guide side-by-side model comparison | `model_ids` (comma-separated)                                          |

---

## Local Development

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9 (`npm install -g pnpm`)
- A [Neon](https://neon.tech) or local Postgres database (Vercel provisions Neon automatically on deploy)
- An [OpenRouter](https://openrouter.ai) API key

### Setup

```bash
# 1. Clone and install
git clone https://github.com/tj60647/openrouter-mcp-registry
cd openrouter-mcp-registry
pnpm install

# 2. Configure environment
cp apps/mcp/.env.example apps/mcp/.env.local
cp apps/web/.env.example apps/web/.env.local
# Edit both .env.local files and fill in the required values
# apps/mcp uses POSTGRES_URL at runtime. apps/web uses POSTGRES_URL only for local/CI scripts.
# For local dev, apps/web/.env.local should have:
#   MCP_URL=http://localhost:3001   ← points the chatbot at the local MCP server

# 3. Run database migrations
pnpm db:migrate

# This also creates/backfills model lifecycle fields such as:
# provider_expiration_at, last_seen_at, and retired_at

# 4. (Optional) Seed demo data
pnpm db:seed

# 5. Start development servers
pnpm dev
# web → http://localhost:3000
# mcp → http://localhost:3001
```

### Available Scripts

| Script            | Description                 |
| ----------------- | --------------------------- |
| `pnpm dev`        | Start all apps in parallel  |
| `pnpm build`      | Build both Next.js apps. `packages/shared` has no build step: it is consumed as TypeScript source through `transpilePackages`, and its `exports` point at `./src/index.ts` |
| `pnpm test`       | Run all tests               |
| `pnpm typecheck`  | TypeScript type check       |
| `pnpm lint`       | Lint all packages           |
| `pnpm db:migrate` | Run database migrations     |
| `pnpm db:seed`    | Seed demo models            |

---

## Deployment (Vercel)

There are **two separate Vercel projects** — one for each app. Both share the same Neon Postgres database.

> **Minimum viable deployment:** you only need `apps/mcp`. Deploy `apps/web` only if you want the demo UI.

---

### Project 1 — `apps/mcp` (required)

This is the MCP server. It owns the database writes and the daily cron sync.

#### 1. Create the Vercel project

1. Go to [vercel.com/new](https://vercel.com/new) and import your fork
2. Under **Root Directory**, enter `apps/mcp`
3. Vercel will auto-detect Next.js and configure the build

#### 2. Add a Neon database

In the **`mcp`** Vercel project → **Storage** → **Connect Database** → **Create New** → **Neon**

Vercel automatically injects `POSTGRES_URL` and `CRON_SECRET` into the project's environment.

#### 3. Set environment variables

In **Settings → Environment Variables**:

| Variable              | Required         | Description                                                                                                      |
| --------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`  | ✅               | Your [OpenRouter](https://openrouter.ai) API key — used for model fetching and generating description embeddings |
| `POSTGRES_URL`        | ✅               | Neon pooled runtime connection string injected by Vercel Storage, or copied from Neon                            |
| `ADMIN_SECRET`        | ✅               | Random secret for admin endpoints                                                                                |
| `OAUTH_JWT_SECRET`    | ✅ in production | Signs short-lived JWT access tokens for `/api/mcp`. Generate with `openssl rand -hex 32`.                        |
| `MCP_CLIENT_ID`       | ✅ for web demo  | Static OAuth client id shared with `apps/web` for the `/demo` chatbot                                            |
| `MCP_CLIENT_SECRET`   | ✅ for web demo  | Static OAuth client secret shared with `apps/web`; server-side only                                              |
| `NEXT_PUBLIC_MCP_URL` | ❌               | Public canonical MCP URL; set for custom domains, otherwise `VERCEL_URL` is used                                 |
| `NEXT_PUBLIC_WEB_URL` | ❌               | Public URL of the docs host (`apps/web`). When set, `/mcp-info` 308-redirects there instead of 404ing            |
| `OAUTH_REGISTRATION_ACCESS_TOKEN` | ❌   | When set, `POST /api/oauth/register` requires `Authorization: Bearer <this value>`; unset keeps registration open |

#### 4. Run database migrations

> **Deploy ordering:** run `pnpm db:migrate` **before** the new `apps/mcp` build serves traffic. The migration is idempotent and safe to re-run, and the old build tolerates the new columns, so migrating first is always the correct order. What breaks if you deploy first:
>
> | Missing schema | Effect on the new build |
> | -------------- | ----------------------- |
> | `rate_limits` table | Rate limiting is **disabled** and every check logs `rate_limits table is missing` at error level. This one deliberately fails *open*: failing closed would 429 every OAuth endpoint and every MCP tool call at once, and a forgotten manual migration should not be a total outage. Grep your logs for that message after any deploy. |
> | `sync_history.status` / `finished_at` / `partial` | `get_sync_history` errors, and `/api/cron/sync` fails while opening its attempt. The catalogue is not modified, so nothing is corrupted — the sync simply does not run until you migrate. |
> | `oauth_clients.registration_access_token_hash` | `POST /api/oauth/register` fails. Rows predating the column get `NULL` and cannot use the RFC 7592 management endpoint (always `401` there); the admin panel's revoke action still covers them. |
>
> **The migration removes rows, once.** Before the lifecycle existed, every sync wrote *two* `sync_history` rows: a start marker, then the real outcome. Under the one-row-per-attempt model those markers are duplicates, and leaving them would make `get_sync_history` report roughly half of all historical syncs as attempts that died mid-run — the opposite of the truth, and contrary to what the tool's own description tells an agent. The migration deletes a marker only when a completed row follows it within ten minutes; an unpaired marker is kept and correctly reported as `running`.
>
> It snapshots the table into `sync_history_pre_lifecycle_backup` first (created once, never overwritten on a re-run) and prints how many rows it touched. To undo:
>
> ```sql
> DELETE FROM sync_history;
> INSERT INTO sync_history SELECT * FROM sync_history_pre_lifecycle_backup;
> ```
>
> Drop that table once you are satisfied with the migrated history.

After the first deploy, run migrations against your Neon database:

```bash
# Pull the injected env vars locally
npx vercel env pull apps/mcp/.env.local --project <your-mcp-project-name>

# Run migrations and seed demo models
pnpm db:migrate
pnpm db:seed
```

> `pnpm db:migrate` and `pnpm db:seed` execute in the `apps/web` workspace (where the migration scripts live), but they use the `POSTGRES_URL` from your environment, so they work against whichever database the env var points to.

#### 5. Cron job

`apps/mcp/vercel.json` configures a daily cron at `0 0 * * *` (midnight UTC) that calls `/api/cron/sync`. When `CRON_SECRET` is set on the project, Vercel sends it to the cron invocation as a Bearer token. The same route can be triggered on demand with `curl -sS <mcp-host>/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"` (a `GET`), or from the admin panel's **Sync** action.

Each sync writes **one** `sync_history` row. It is opened with `status = 'running'` (`success: null`) before OpenRouter is contacted and updated in place when the attempt ends, so a `success: false` row is always a genuine failure and always carries an `error`. `synced_at` is the attempt's start and `finished_at` its end (`null` while running); a `running` row older than the newest finished row is an attempt whose process died mid-sync. `partial: true` marks a run that updated the catalogue but skipped the retirement sweep because the upstream response looked truncated.

Rows written before this lifecycle existed are backfilled by `pnpm db:migrate`: old start markers become `running` rather than being counted as outages.

> **Note:** You must set `CRON_SECRET` yourself — Vercel does **not** create it automatically (the Neon integration does not provide it). In production the cron route returns `503` ("Cron auth not configured") when the secret is missing and `NODE_ENV=production`, so the job fails on every run until you set it. Generate one with `openssl rand -hex 32`, add it to the project's Production environment, and redeploy so the new deployment picks it up.

---

### Project 2 — `apps/web` (optional demo UI + MCP-client chatbot)

This is a human-facing browser for the registry. The **`/demo` chatbot** posts to an `apps/web` server route, which obtains a short-lived MCP bearer token with server-side `MCP_CLIENT_ID`/`MCP_CLIENT_SECRET` and delegates chat generation to `apps/mcp` `/api/chat`. Browser-facing registry reads go through `apps/web` route handlers that proxy to `apps/mcp`. `apps/web` does not need OpenRouter or Neon/Postgres credentials at Vercel runtime.

#### 1. Create the Vercel project

1. Import the **same fork** to a second Vercel project
2. Under **Root Directory**, enter `apps/web`

#### 2. Do not connect production Neon to apps/web runtime

`apps/web` Vercel preview/prod should not receive `POSTGRES_URL` unless you intentionally add a new web-owned runtime database feature. Migration, seed, and admin bootstrap scripts still live in the web workspace and may use `POSTGRES_URL` locally or in CI only.

#### 3. Set environment variables

| Variable               | Required           | Description                                                                                                                                       |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_SESSION_SECRET` | ✅ if admin UI is enabled | Random 32-byte hex secret for web-owned admin session cookies (`openssl rand -hex 32`)                                                       |
| `NEXT_PUBLIC_MCP_URL`  | ✅                 | Public URL of your deployed `mcp` app (e.g. `https://your-mcp-app.vercel.app`) — browser-visible URL only. Also gates and targets the 308 redirects for `/api/mcp`, `/api/oauth/*` and `/.well-known/*`; unset means no redirects are emitted |
| `MCP_CLIENT_ID`        | ✅ in preview/prod | Server-side OAuth client id used by web route handlers to obtain an MCP access token; must match `apps/mcp`                                    |
| `MCP_CLIENT_SECRET`    | ✅ in preview/prod | Server-side OAuth client secret used by web route handlers; must match `apps/mcp` and must not be `NEXT_PUBLIC`                                |
| `NEXT_PUBLIC_APP_URL`  | ❌                 | Public URL of this web app; browser-visible URL only                                                                                            |
| `MCP_URL`              | ❌                 | Server-side MCP URL override; use for local dev (`http://localhost:3001`) or private/internal routing                                           |
| `CHAT_MODEL`           | ❌                 | Default chat model id forwarded to `apps/mcp` (default: `google/gemini-3.5-flash`). Must match `provider/model-name`.                          |

Do not set `OPENROUTER_API_KEY`, `POSTGRES_URL`, `ADMIN_SECRET`, `OAUTH_JWT_SECRET`, or `CRON_SECRET` on the `apps/web` Vercel runtime.

#### 4. Bootstrap the first web admin

After `pnpm db:migrate`, create the first login account in Postgres:

```bash
ADMIN_BOOTSTRAP_PASSWORD=choose-a-strong-password pnpm db:create-admin -- --username admin
```

This upserts an active admin row in the `admins` table. The web login no longer reads admin credentials from environment variables.

#### Rate limits

The following server-side limits are enforced per-IP (per Vercel function instance):

| Endpoint                | Limit        | Window     |
| ----------------------- | ------------ | ---------- |
| `POST /api/admin/login` | 5 requests   | 15 minutes |
| `POST /api/chat`        | 20 requests  | 1 minute   |
| `POST /api/mcp`         | 120 requests | 1 minute   |

Requests that exceed the limit receive a `429 Too Many Requests` response.

---

### `vercel.json` reference

| File                      | Used by                                           | Purpose                                         |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `apps/mcp/vercel.json`    | `apps/mcp` Vercel project                         | Daily cron at `/api/cron/sync`                  |
| `vercel.json` (repo root) | Repo-root deployments                             | Metadata only; no web cron or backend sync work |

Cron and backend sync are intentionally configured only for `apps/mcp`.

---

## MCP Client Setup

The MCP endpoint is served by **`apps/mcp`** at `POST /api/mcp`.

In production the endpoint is protected by OAuth 2.1. **Interactive clients (Claude Code, Cursor, VS Code, Claude Desktop, Codex) authenticate automatically** — they discover the server's OAuth metadata from the `401` response, self-register via dynamic client registration, and open a browser to authorize (authorization code + PKCE). Because the registry serves public model data, authorization is auto-approved, so there is no consent screen and no token to paste. You only need to supply a bearer token for non-interactive/server-side clients — see [With OAuth bearer tokens](#with-oauth-bearer-tokens).

### Claude Code

```bash
claude mcp add --transport http registry https://your-mcp-app.vercel.app/api/mcp
```

The first time an agent calls a registry tool, Claude Code runs the OAuth browser login; after that it stays connected. Registered clients (and per-agent usage) are visible in the admin panel under **Clients** and **Usage**.

### Cursor

Add to `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`); Cursor completes the OAuth flow in the browser on first use:

```json
{
  "mcpServers": {
    "openrouter-registry": {
      "url": "https://your-mcp-app.vercel.app/api/mcp"
    }
  }
}
```

### Claude Desktop

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openrouter-registry": {
      "url": "https://your-mcp-app.vercel.app/api/mcp",
      "transport": "streamable-http"
    }
  }
}
```

### With OAuth bearer tokens

Interactive clients don't need this — they authenticate automatically (above). This path is for **non-interactive / server-side clients** that can't run a browser OAuth flow. In production, `apps/mcp` has `OAUTH_JWT_SECRET` configured, so `/api/mcp` requires a bearer token with the `mcp:read` scope. Trusted server-side clients request a short-lived token from `POST /api/oauth/token` using the client-credentials grant with `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`; browser code must not receive these credentials.

```bash
# 1. Get a token (form-encoded or JSON; credentials in the body or as HTTP Basic)
curl -sS -X POST https://your-mcp-app.vercel.app/api/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' \
  -d 'client_id=YOUR_CLIENT_ID' \
  -d 'client_secret=YOUR_CLIENT_SECRET' \
  -d 'scope=mcp:read'
# → {"access_token":"...","token_type":"Bearer","expires_in":3600,"scope":"mcp:read"}

# 2. Call a tool. BOTH media types must appear in Accept, or the transport returns 406.
curl -sS -X POST https://your-mcp-app.vercel.app/api/mcp \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_models","arguments":{"limit":5}}}'
# → 200 text/event-stream, one frame: event: message / data: {"result":{...},"jsonrpc":"2.0","id":1}
```

`expires_in` is `3600`. **Cache the token** and reuse it until it is close to expiry — the token endpoint is rate-limited to 20 requests per minute per IP, and the client-credentials grant issues no refresh token.

The endpoint is stateless: `initialize` and `notifications/initialized` are **not** required before `tools/call`, no `Mcp-Session-Id` is ever returned, and successful responses are always `text/event-stream` regardless of `Accept`. Tool failures come back as HTTP `200` with `result.isError: true`, so check that field rather than the status code. `GET`/`DELETE` on `/api/mcp` return `405`. Full transport details are on the `/mcp-info` page of the docs host.

```json
{
  "mcpServers": {
    "openrouter-registry": {
      "url": "https://your-mcp-app.vercel.app/api/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer YOUR_SHORT_LIVED_ACCESS_TOKEN"
      }
    }
  }
}
```

### Registering your own OAuth client

Dynamic client registration is open by default (the catalogue is public read-only data and interactive MCP clients depend on self-registration). `grant_types` is honoured per RFC 7591 §3.2.1 and echoed back exactly as resolved.

```bash
curl -sS -X POST https://your-mcp-app.vercel.app/api/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"my-service","grant_types":["client_credentials"],"scope":"mcp:read"}'
# → 201 with client_id, client_secret (once), client_secret_expires_at: 0, client_id_issued_at,
#   grant_types, token_endpoint_auth_method, registration_access_token (once), registration_client_uri
```

- Supported grants: `authorization_code`, `refresh_token`, `client_credentials`.
- Omitting `grant_types` defaults to `["authorization_code","refresh_token"]` when `redirect_uris` is supplied, and `["client_credentials"]` when it is not.
- A client with `redirect_uris` is **public** (no secret, `token_endpoint_auth_method: "none"`, PKCE). A client without them is **confidential** (secret issued, `client_secret_post`).
- Requesting `client_credentials` together with `redirect_uris` is rejected with `400 invalid_client_metadata` — a public client holds no secret, so honouring that grant would issue tokens to anyone who learns the `client_id`. Also rejected: an empty `grant_types` array, unsupported values, `refresh_token` without `authorization_code`, and `authorization_code`/`refresh_token` with no `redirect_uris`. Nothing is written to the database when a rule fires.
- At the token endpoint, requesting a grant the client is not registered for returns `400 unauthorized_client`. Grants this server does not implement at all still return `400 unsupported_grant_type`.
- Clients registered before `grant_types` was enforced keep working: a stored client that has a secret and no `redirect_uris` gets `client_credentials` added to its effective grant list on read. Public (secret-less) clients are deliberately **not** grandfathered.
- Registration is rate-limited to 5 per 15 minutes per IP, counted in Postgres so the limit holds across serverless instances. Operators can require an initial access token with `OAUTH_REGISTRATION_ACCESS_TOKEN`, or disable registration entirely with `OAUTH_DISABLE_REGISTRATION=true`.
- Open registration is a deliberate choice, and the exposure it grants is bounded: the only grantable scope is `mcp:read`, every tool is read-only, and the tool path itself carries a per-client budget — 600 calls/minute overall and 60/minute for `semantic_search`, the one tool that spends money by embedding its query. Throttled calls return an MCP error result and never reach the database or OpenRouter.

#### Managing a registration (RFC 7592)

The registration response carries a `registration_client_uri` and a one-time `registration_access_token`, so a client can inspect or delete itself without operator involvement:

```bash
# Read the current registration (never returns client_secret)
curl -sS https://your-mcp-app.vercel.app/api/oauth/register/YOUR_CLIENT_ID \
  -H "Authorization: Bearer $REGISTRATION_ACCESS_TOKEN"

# Delete (revoke) it
curl -sS -X DELETE https://your-mcp-app.vercel.app/api/oauth/register/YOUR_CLIENT_ID \
  -H "Authorization: Bearer $REGISTRATION_ACCESS_TOKEN"
# → 204 No Content
```

- `DELETE` is a revoke: the client can no longer authorize or obtain tokens, and the row is retained so the admin panel can still restore it. Already-issued access tokens stay valid until they expire (within the hour).
- Every failure — missing/invalid header, wrong token, unknown `client_id`, already-deleted client — returns the same flat `401 {"error":"invalid_token"}`. There is deliberately no `404`, so the endpoint cannot be used to enumerate client IDs; a second `DELETE` therefore looks like an auth failure.
- The `registration_access_token` is stored only as a SHA-256 hash. It cannot be read back or rotated — if it is lost, an operator must clean the client up from the admin panel. Clients registered before this endpoint existed have no management token and always receive `401` here.
- Rate-limited to 30 requests per 15 minutes per IP.

### GitHub Copilot (VS Code)

Add to your workspace's `.vscode/mcp.json` (or to your user `settings.json` under the `"mcp"` key):

```json
{
  "servers": {
    "openrouter-registry": {
      "type": "http",
      "url": "https://your-mcp-app.vercel.app/api/mcp"
    }
  }
}
```

If your MCP client cannot complete OAuth discovery automatically, add a short-lived bearer token header:

```json
{
  "servers": {
    "openrouter-registry": {
      "type": "http",
      "url": "https://your-mcp-app.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_SHORT_LIVED_ACCESS_TOKEN"
      }
    }
  }
}
```

> VS Code discovers `.vscode/mcp.json` automatically. You can also add the same block under `"mcp": { "servers": { ... } }` in your user or workspace `settings.json`.

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.openrouter-registry]
url = "https://your-mcp-app.vercel.app/api/mcp"
```

For authenticated production MCP deployments, configure a short-lived bearer token if your client does not perform OAuth discovery automatically:

```toml
[mcp_servers.openrouter-registry]
url = "https://your-mcp-app.vercel.app/api/mcp"
bearer_token = "YOUR_SHORT_LIVED_ACCESS_TOKEN"
```

### Using in an agent

```typescript
// Resolve a model ID to its canonical form and fetch its details
const result = await mcp.callTool('resolve_model', { input: 'anthropic/claude-sonnet-4-5' });
// → { resolved: 'anthropic/claude-sonnet-4-5', source: 'canonical', found: true, model: {...} }

// List models (default limit is 50; `total` tells you how many match, ignoring limit/offset)
const models = await mcp.callTool('list_models', { limit: 50, provider: 'anthropic' });
// → { models: [...], count: 50, total: 120 }

// Exclude retired models, and trim the payload to just the fields you need
const current = await mcp.callTool('list_models', {
  limit: 500,
  availableOnly: true,
  fields: ['displayName', 'contextLength', 'inputPricePer1k', 'outputPricePer1k'], // id always included
});

// description and metadata are omitted by default — ask for them explicitly
const withDescriptions = await mcp.callTool('list_models', { limit: 20, verbose: true });

// Search models by name, ID, or provider substring; sortBy takes either casing
const results = await mcp.callTool('search_models', {
  query: 'claude',
  limit: 10,
  sortBy: 'createdAt', // same as 'created_at'
  sortDir: 'desc',
});

// Get full details for a single model by canonical ID
const model = await mcp.callTool('get_model', { id: 'anthropic/claude-sonnet-4-5' });

// Find models that fit a budget and context requirement
const affordable = await mcp.callTool('find_models_by_criteria', {
  maxInputPricePer1k: 0.005,
  maxOutputPricePer1k: 0.015,
  minContextLength: 32000,
  limit: 20,
});

// Filter by modality — match the INPUT side of the `inputs->outputs` string for vision models.
// 'text->image' would be an image GENERATOR, not a vision model.
const visionModels = await mcp.callTool('find_models_by_criteria', {
  modality: 'image->',
  limit: 20,
});

// Semantic search — find models by natural language description
// (uses OPENROUTER_API_KEY to call openai/text-embedding-3-small via OpenRouter)
const semantic = await mcp.callTool('semantic_search', {
  query: 'fast cheap summarization model with a large context window',
  limit: 10,
});

// Compare 2–5 models side-by-side (pricing, context length, metadata)
const comparison = await mcp.callTool('compare_models', {
  ids: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-pro-1.5'],
});

// Get the current registry sync status plus live row counts
const status = await mcp.callTool('get_registry_status', {});
// → { status: { lastSuccessfulSync, lastAttemptedSync, lastError,
//               recordCount, totalCount, availableCount, retiredCount } }

// Read the full model list as a resource
const resource = await mcp.readResource('registry://models');
// → { contents: [{ mimeType: 'application/json', text: '{"models":[...]}' }] }

// Read a specific model as a resource
const modelResource = await mcp.readResource('registry://models/anthropic%2Fclaude-sonnet-4-5');

// Use the select_model prompt to guide model selection
const prompt = await mcp.getPrompt('select_model', {
  task_description: 'Summarize long legal documents',
  budget_usd_per_1k_tokens: '0.005',
  min_context_length: '32000',
});

// Use the compare_models_prompt to guide a structured comparison
const comparePrompt = await mcp.getPrompt('compare_models_prompt', {
  model_ids: 'anthropic/claude-sonnet-4-5,openai/gpt-4o',
});
```

---

## Admin Panel

The `apps/web` deployment includes an admin area at `/admin`, reachable from the **Admin** tab in the header and protected by a username/password login (session cookie signed with `ADMIN_SESSION_SECRET`). Create or reset the admin user with `pnpm db:create-admin` (see [Available Scripts](#available-scripts)).

The panel provides:

- **Dashboard** — entry point to the sections below.
- **Clients** — every OAuth client (coding agent) that has registered via dynamic client registration, with a **Revoke/Restore** action. Revoking immediately blocks a client from obtaining new access tokens (existing tokens expire within an hour).
- **Usage** — MCP tool calls attributed to each client, plus a breakdown by tool, over a 7/30/90-day window. Every `/api/mcp` tool call is recorded per client, so you can see which agents are using the registry and how.
- **Sync** — trigger a manual model-catalog refresh on demand (in addition to the daily cron).

---

## Database Schema

> `apps/mcp` is the runtime owner of the Neon Postgres database. Migration, seed, and admin bootstrap scripts still live in `apps/web/scripts/` and are run via `pnpm db:migrate`, `pnpm db:seed`, and `pnpm db:create-admin` from the repo root with a local/CI `POSTGRES_URL`; `apps/web` Vercel runtime should not connect to Neon.

```sql
-- Enable pgvector (required for description_embedding)
CREATE EXTENSION IF NOT EXISTS vector;

-- Cached model catalog from OpenRouter
CREATE TABLE models (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  description           TEXT,                    -- model description from OpenRouter
  modality              TEXT,                    -- e.g. "text+image->text", "text->text"
  context_length        INTEGER,
  max_completion_tokens INTEGER,                 -- max output tokens
  input_price_per_1k    NUMERIC(18,10),
  output_price_per_1k   NUMERIC(18,10),
  image_price_per_1k    NUMERIC(18,10),          -- image input pricing
  created_at            TIMESTAMPTZ,             -- when the model was published on OpenRouter
  supported_parameters  TEXT[],                  -- e.g. ["tools", "reasoning", "temperature"]
  metadata              JSONB NOT NULL DEFAULT '{}',
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description_embedding vector(1536)             -- auto-generated via OpenRouter embeddings
);

-- GIN index for fast containment queries on supported_parameters
-- (e.g. WHERE 'tools' = ANY(supported_parameters))
CREATE INDEX models_supported_params_gin_idx
  ON models USING gin (supported_parameters);

-- HNSW index for fast cosine-similarity search on description embeddings
CREATE INDEX models_embedding_hnsw_idx
  ON models USING hnsw (description_embedding vector_cosine_ops);

-- Singleton sync state row
CREATE TABLE sync_status (
  id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_successful_sync TIMESTAMPTZ,
  last_attempted_sync  TIMESTAMPTZ,
  last_error           TEXT,
  record_count         INTEGER NOT NULL DEFAULT 0
);
```

`pnpm db:migrate` also creates and backfills the model lifecycle columns (`provider_expiration_at`, `last_seen_at`, `retired_at`, `is_available`), the `sync_history` and `admins` tables, and the `oauth_clients` table — including `revoked_at` and `registration_access_token_hash` (the SHA-256 hash of the RFC 7592 management token; `NULL` for clients registered before that endpoint existed). The script is a single idempotent run of `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so it is safe to re-run.

---

## Security

- **Admin endpoints** require `Authorization: Bearer <ADMIN_SECRET>` header
- **MCP endpoint** requires OAuth bearer tokens in production when `OAUTH_JWT_SECRET` is configured; local dev/test may run anonymously when it is unset
- **Grant types are enforced.** The token endpoint rejects a grant the client is not registered for with `400 unauthorized_client`, and registration refuses `client_credentials` for any client that has `redirect_uris` (such a client is public and holds no secret, so the grant would issue tokens to anyone who learns its `client_id`)
- **Cron endpoint** is protected by `CRON_SECRET` (injected by Vercel automatically)
- All user inputs validated with [Zod](https://zod.dev)
- Model IDs treated as opaque strings — LLM reasoning never determines validity

---

## Testing

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @openrouter-mcp/shared test
pnpm --filter @openrouter-mcp/mcp test
```

Tests cover:

- Model ID canonicalization
- Model registry resolution logic
- Sync service (success, lock contention, provider errors)
- Auth guards (admin token, OAuth token/client credentials, MCP token)

---

## Environment Variables Reference

`NEXT_PUBLIC_*` variables are browser-visible in Next.js. They must contain only public URLs or other non-secret values. Never put provider keys, database URLs, MCP client secrets, OAuth JWT secrets, admin secrets, cron secrets, or database credentials in `NEXT_PUBLIC_*`.

`apps/mcp` owns OpenRouter and Neon/Postgres at runtime. `apps/web` calls `apps/mcp` from server-side route handlers using `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`; those credentials are never sent to the browser.

### `apps/web` local

| Variable | Required | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | ❌ | Public local/web URL, usually `http://localhost:3000`. Browser-visible, not a secret. |
| `NEXT_PUBLIC_MCP_URL` | ❌ | Public MCP URL, usually `http://localhost:3001`. Browser-visible, not a secret. Also enables the cross-host 308 redirects in `next.config.ts`; leave unset for single-host local dev. |
| `MCP_URL` | ❌ | Server-side MCP URL override for route handlers. Defaults to `NEXT_PUBLIC_MCP_URL` when set. |
| `MCP_CLIENT_ID` | ❌ locally | Server-side client id for protected MCP calls. May be omitted when local `apps/mcp` has no `OAUTH_JWT_SECRET`. |
| `MCP_CLIENT_SECRET` | ❌ locally | Server-side client secret for protected MCP calls. May be omitted when local `apps/mcp` has no `OAUTH_JWT_SECRET`. |
| `ADMIN_SESSION_SECRET` | ✅ for web admin UI | Signs web-owned admin session cookies only. |
| `CHAT_MODEL` | ❌ | Chat model id passed through to `apps/mcp` `/api/chat`. |

### `apps/web` Vercel preview/prod

| Variable | Required | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | ✅ | Public URL of the web deployment. Browser-visible, not a secret. |
| `NEXT_PUBLIC_MCP_URL` | ✅ | Public URL of the MCP deployment. Browser-visible, not a secret. Also the target of this app's 308 redirects for `/api/mcp`, `/api/mcp/*`, `/api/oauth/*` and `/.well-known/*`. Baked in at build time — changing it needs a redeploy. |
| `MCP_CLIENT_ID` | ✅ | Server-side OAuth client id used by web route handlers to request an MCP bearer token. |
| `MCP_CLIENT_SECRET` | ✅ | Server-side OAuth client secret used only by web route handlers. Never expose to client components. |
| `ADMIN_SESSION_SECRET` | ✅ if web admin UI is enabled | Signs web-owned admin session cookies. |
| `MCP_URL` | ❌ | Optional server-side override for `NEXT_PUBLIC_MCP_URL`. |
| `CHAT_MODEL` | ❌ | Optional default chat model id forwarded to `apps/mcp`. |

`apps/web` Vercel runtime does **not** require `OPENROUTER_API_KEY`, `POSTGRES_URL`, `DATABASE_URL`, `ADMIN_SECRET`, `OAUTH_JWT_SECRET`, or `CRON_SECRET`.

### `apps/mcp` local

| Variable | Required | Description |
| --- | --- | --- |
| `POSTGRES_URL` | ✅ | Neon/Postgres connection string for registry/admin data. Use a local/dev database. |
| `OPENROUTER_API_KEY` | ✅ for sync/chat/embeddings | OpenRouter API key used by MCP-owned sync, embeddings, and chat. |
| `ADMIN_SECRET` | ✅ for admin endpoints | Server-side bearer token for MCP admin endpoints. |
| `OAUTH_JWT_SECRET` | ❌ locally | Leave unset for simple local anonymous MCP access; set it to test fail-closed OAuth. |
| `MCP_CLIENT_ID` | ✅ when OAuth is enabled | Static client id for server-to-server clients. |
| `MCP_CLIENT_SECRET` | ✅ when OAuth is enabled | Static client secret for server-to-server clients. |
| `NEXT_PUBLIC_MCP_URL` | ❌ | Public canonical MCP URL. Browser-visible, not a secret. |
| `NEXT_PUBLIC_WEB_URL` | ❌ | Public URL of the docs host (`apps/web`); same value as its `NEXT_PUBLIC_APP_URL`. When set, `/mcp-info` 308-redirects there. Browser-visible, not a secret. |
| `OAUTH_DISABLE_REGISTRATION` | ❌ | Set to `true` to refuse dynamic client registration. |
| `OAUTH_REGISTRATION_ACCESS_TOKEN` | ❌ | When set, `POST /api/oauth/register` requires `Authorization: Bearer <this value>`. Unrelated to the per-client `registration_access_token` in a registration response. |
| `CRON_SECRET` | ❌ locally | Optional cron bearer token. |

### `apps/mcp` Vercel preview/prod

| Variable | Required | Description |
| --- | --- | --- |
| `POSTGRES_URL` | ✅ | Neon/Postgres connection string. Preview deployments should use a Neon preview/dev branch, not the production branch. |
| `OPENROUTER_API_KEY` | ✅ | OpenRouter API key; `apps/mcp` is the only runtime owner. |
| `OAUTH_JWT_SECRET` | ✅ | Signs short-lived OAuth/JWT access tokens. Production MCP access fails closed without it. |
| `MCP_CLIENT_ID` | ✅ for web demo/proxies | Static OAuth client id shared with `apps/web` server-side env. |
| `MCP_CLIENT_SECRET` | ✅ for web demo/proxies | Static OAuth client secret shared with `apps/web` server-side env. |
| `ADMIN_SECRET` | ✅ | Server-side bearer token for MCP admin mutations. |
| `CRON_SECRET` | ✅ if cron routes are deployed | Server-side cron bearer token. Vercel can inject this for cron jobs. |
| `NEXT_PUBLIC_MCP_URL` | ❌ | Public canonical MCP URL for metadata/custom domains. Browser-visible, not a secret. |
| `NEXT_PUBLIC_WEB_URL` | ❌ | Public URL of the docs host (`apps/web`); same value as its `NEXT_PUBLIC_APP_URL`. When set, this app 308-redirects `/mcp-info` there instead of 404ing. Baked in at build time. Browser-visible, not a secret. |
| `OAUTH_DISABLE_REGISTRATION` | ❌ | Set to `true` to refuse OAuth dynamic client registration. Registration is enabled by default so interactive MCP clients can complete the authorization-code + PKCE flow. |
| `OAUTH_REGISTRATION_ACCESS_TOKEN` | ❌ | Optional RFC 7591 §3.1 initial access token. When set, `POST /api/oauth/register` requires `Authorization: Bearer <this value>` and returns `401 invalid_token` otherwise; unset keeps registration open, which is what interactive MCP clients need to bootstrap. Distinct from the per-client `registration_access_token` returned by a registration response. |

### Local/CI script-only

| Variable | Required | Description |
| --- | --- | --- |
| `POSTGRES_URL` | ✅ for `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:create-admin` | Used by migration, seed, and bootstrap scripts in `apps/web/scripts`; not an apps/web Vercel runtime requirement. |
| `ADMIN_BOOTSTRAP_USERNAME` | ❌ | Optional default username for `pnpm db:create-admin`. |
| `ADMIN_BOOTSTRAP_PASSWORD` | ✅ for non-interactive admin bootstrap | Password used to create/update the first admin user. |

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Run `pnpm typecheck && pnpm test` before submitting
4. Open a pull request

---

## License

MIT
