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

- Fetches the live model catalog from OpenRouter weekly (and on-demand)
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

---

## REST API

Both apps expose REST routes, but **`apps/mcp`** is the canonical backend and runtime owner of OpenRouter, Neon/Postgres, registry data, provider/model resolution, embeddings, sync jobs, MCP auth validation, admin mutations, and cron endpoints. **`apps/web`** exposes browser-facing route handlers that proxy to `apps/mcp` and stores only optional web-owned admin session cookies; it does not require `OPENROUTER_API_KEY` or `POSTGRES_URL` at Vercel runtime.

### `apps/mcp` routes (full API)

| Method | Path                     | Description                                                     |
| ------ | ------------------------ | --------------------------------------------------------------- |
| `GET`  | `/api/models`            | List cached models (`?limit`, `?offset`, `?provider`, `?query`) |
| `GET`  | `/api/models/:id`        | Get model by canonical ID                                       |
| `POST` | `/api/resolve`           | Resolve model ID → canonical model                              |
| `GET`  | `/api/health`            | Health check + sync status summary                              |
| `POST` | `/api/admin/refresh`     | Trigger manual sync (requires `ADMIN_SECRET`)                   |
| `POST` | `/api/admin/verify-login`| Verify admin credentials for web-owned sessions (requires MCP OAuth when configured) |
| `GET`  | `/api/admin/sync-status` | Full sync status (requires `ADMIN_SECRET`)                      |
| `GET`  | `/api/cron/sync`         | Daily cron sync (protected by `CRON_SECRET`)                    |
| `POST` | `/api/mcp`               | MCP Streamable HTTP endpoint                                    |
| `GET`/`POST` | `/api/chat`        | MCP-owned demo chat endpoint; owns OpenRouter call and registry tool execution |

### `apps/web` routes (demo UI)

| Method | Path                 | Description                                                                                                                                              |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/models`        | List cached models (`?limit`, `?offset`, `?provider`, `?query`, `?sortBy`, `?sortDir`, `?toolsOnly`, `?reasoningOnly`, `?availableOnly`, `?retiredOnly`) |
| `GET`  | `/api/providers`     | List distinct provider names                                                                                                                             |
| `POST` | `/api/resolve`       | Resolve model ID → canonical model                                                                                                                       |
| `GET`  | `/api/health`        | Health check                                                                                                                                             |
| `GET`  | `/api/chat`          | Agent config — default model, available models, and MCP tools list                                                                                       |
| `POST` | `/api/chat`          | Chatbot proxy — browser posts here; server-side route delegates LLM + tool calls to `apps/mcp`                                                           |
| `POST` | `/api/admin/login`   | Create a web-owned admin session after server-side credential verification by apps/mcp; issues session cookie                                                                                        |
| `POST` | `/api/admin/logout`  | Clear admin session cookie                                                                                                                               |
| `POST` | `/api/admin/refresh` | Removed from web runtime; admin sync is owned by `apps/mcp`                                                                                              |
| `GET`  | `/api/cron/sync`     | Removed from web runtime; cron sync is owned by `apps/mcp`                                                                                               |

## MCP Capabilities

Connect any MCP-compatible client to `POST /api/mcp`. The server exposes **tools**, **resources**, and **prompts**.

### Tools

| Tool                      | Description                                     | Parameters                                                                                                          |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `list_models`             | List all registry models                        | `limit`, `offset`, `provider`, `query`, `sortBy`, `sortDir`, `availableOnly`                                        |
| `resolve_model`           | Resolve and look up a model by ID               | `input: string`                                                                                                     |
| `get_model`               | Get full details for a model                    | `id: string`                                                                                                        |
| `search_models`           | Search by name, ID, or provider                 | `query: string`, `limit`, `offset`, `sortBy`, `sortDir`                                                             |
| `find_models_by_criteria` | Filter by budget, context, and modality         | `maxInputPricePer1k`, `maxOutputPricePer1k`, `minContextLength`, `modality`, `limit`, `offset`, `sortBy`, `sortDir` |
| `compare_models`          | Compare 2–5 models side-by-side                 | `ids: string[]`                                                                                                     |
| `semantic_search`         | Find models by natural language similarity      | `query: string`, `limit`, `offset`                                                                                  |
| `get_registry_status`     | Current sync state                              | —                                                                                                                   |
| `get_sync_history`        | Recent sync attempts with success/error details | `limit`                                                                                                             |

Model lifecycle semantics:

- `isAvailable = true` means the model was present in the latest OpenRouter sync.
- `isAvailable = false` means the model is unavailable in the latest registry sync. This is inferred from sync absence and is not always a provider-declared retirement notice.
- `providerExpirationAt` is the scheduled provider expiry date from OpenRouter when available.
- `retiredAt` is the first sync where this registry observed the model missing.
- `lastSeenAt` is the most recent successful sync where the model was still present.

Notes:

- The web UI now uses the term "Unavailable" instead of "Retired" because sync absence and provider-declared expiry are distinct states.
- The `compare_models` MCP tool now includes lifecycle fields such as `providerExpirationAt`, `lastSeenAt`, `retiredAt`, and `isAvailable` in its response.

### Resources

Read-only data accessible via `resources/read`:

| URI                      | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `registry://models`      | Full model list (up to 500)                        |
| `registry://status`      | Sync status (last sync time, record count, errors) |
| `registry://models/{id}` | Details for a specific model (URL-encode the ID)   |

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
| `pnpm build`      | Build all packages and apps |
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

#### 4. Run database migrations

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

`apps/mcp/vercel.json` configures a daily cron at `0 0 * * *` (midnight UTC) that calls `/api/cron/sync`. When `CRON_SECRET` is set on the project, Vercel sends it to the cron invocation as a Bearer token.

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
| `NEXT_PUBLIC_MCP_URL`  | ✅                 | Public URL of your deployed `mcp` app (e.g. `https://your-mcp-app.vercel.app`) — browser-visible URL only                                      |
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
| `apps/mcp/vercel.json`    | `apps/mcp` Vercel project                         | Weekly cron at `/api/cron/sync`                 |
| `vercel.json` (repo root) | Repo-root deployments                             | Metadata only; no web cron or backend sync work |

Cron and backend sync are intentionally configured only for `apps/mcp`.

---

## MCP Client Setup

The MCP endpoint is served by **`apps/mcp`** at `POST /api/mcp`.

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

In production, `apps/mcp` should have `OAUTH_JWT_SECRET` configured, so `/api/mcp` requires a bearer token with the `mcp:read` scope. Trusted server-side clients can request a short-lived token from `POST /api/oauth/token` with `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET`; browser code must not receive these credentials.

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

// List all available models (with optional provider filter and text search)
const models = await mcp.callTool('list_models', { limit: 50, provider: 'anthropic' });

// Search models by name, ID, or provider substring
const results = await mcp.callTool('search_models', { query: 'claude', limit: 10 });

// Get full details for a single model by canonical ID
const model = await mcp.callTool('get_model', { id: 'anthropic/claude-sonnet-4-5' });

// Find models that fit a budget and context requirement
const affordable = await mcp.callTool('find_models_by_criteria', {
  maxInputPricePer1k: 0.005,
  maxOutputPricePer1k: 0.015,
  minContextLength: 32000,
  limit: 20,
});

// Filter by modality — e.g. vision models that accept images
const visionModels = await mcp.callTool('find_models_by_criteria', {
  modality: 'text+image',
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

// Get the current registry sync status
const status = await mcp.callTool('get_registry_status', {});

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

---

## Security

- **Admin endpoints** require `Authorization: Bearer <ADMIN_SECRET>` header
- **MCP endpoint** requires OAuth bearer tokens in production when `OAUTH_JWT_SECRET` is configured; local dev/test may run anonymously when it is unset
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
| `NEXT_PUBLIC_MCP_URL` | ❌ | Public MCP URL, usually `http://localhost:3001`. Browser-visible, not a secret. |
| `MCP_URL` | ❌ | Server-side MCP URL override for route handlers. Defaults to `NEXT_PUBLIC_MCP_URL` when set. |
| `MCP_CLIENT_ID` | ❌ locally | Server-side client id for protected MCP calls. May be omitted when local `apps/mcp` has no `OAUTH_JWT_SECRET`. |
| `MCP_CLIENT_SECRET` | ❌ locally | Server-side client secret for protected MCP calls. May be omitted when local `apps/mcp` has no `OAUTH_JWT_SECRET`. |
| `ADMIN_SESSION_SECRET` | ✅ for web admin UI | Signs web-owned admin session cookies only. |
| `CHAT_MODEL` | ❌ | Chat model id passed through to `apps/mcp` `/api/chat`. |

### `apps/web` Vercel preview/prod

| Variable | Required | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | ✅ | Public URL of the web deployment. Browser-visible, not a secret. |
| `NEXT_PUBLIC_MCP_URL` | ✅ | Public URL of the MCP deployment. Browser-visible, not a secret. |
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
| `OAUTH_DISABLE_REGISTRATION` | ❌ | Set to `true` to refuse OAuth dynamic client registration. Registration is enabled by default so interactive MCP clients can complete the authorization-code + PKCE flow. |

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
