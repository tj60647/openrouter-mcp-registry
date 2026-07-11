---
name: verify
description: Build, launch, and drive this monorepo's two apps (web + mcp) to verify changes end-to-end.
---

# Verifying changes in this repo

## Launch

Both apps have `.env.local` checked out locally (real config, including DB and OAuth secrets).

```bash
npx -y pnpm dev   # web on :3000, mcp on :3001; ready in ~20-60s
```

Poll readiness: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` (and :3001) until both return 200.

## Surfaces worth driving

- **Web pages**: `http://localhost:3000/` (home), `/models`, `/resolve`, `/sync-status`, `/admin/login`. Note `/models` is client-rendered — SSR HTML only shows "Loading"; hit the API instead.
- **Web data APIs (proxy to mcp)**: `GET http://localhost:3000/api/models?limit=3`, `/api/providers`. A 200 with model JSON proves the whole web → OAuth token → mcp → Postgres chain.
- **MCP endpoint**: requires a bearer token locally (OAUTH_JWT_SECRET is set).
  1. Read `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET` from `apps/mcp/.env.local`.
  2. `POST http://localhost:3001/api/oauth/token` with `{"grant_type":"client_credentials","client_id":...,"client_secret":...,"scope":"mcp:read"}` → `access_token` (JWT; decode payload to check `aud`/`iss`/`scope`).
  3. `POST http://localhost:3001/api/mcp` with `Authorization: Bearer <token>`, headers `Content-Type: application/json` and `Accept: application/json, text/event-stream`, body = JSON-RPC `initialize` → response includes `serverInfo`.
- **Admin login**: `POST http://localhost:3000/api/admin/login` with `{"username","password"}`; needs an admin row in Postgres (seed via `npx -y pnpm db:create-admin`).

## Gotchas

- Unauthenticated `POST /api/mcp` returns 401 `invalid_token` — that's correct behavior, not a broken server.
- Avoid driving `/demo` chat or `POST /api/chat` unless needed — it spends OpenRouter credits.
- Dev servers run via one parallel pnpm task; stop the task (not individual node PIDs) when done.
