import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '@vercel/postgres';

function loadLocalEnvIfPresent() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, '..', '.env.local');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function migrate() {
  loadLocalEnvIfPresent();

  if (!process.env.POSTGRES_URL) {
    throw new Error('POSTGRES_URL is not set. Add it to apps/web/.env.local or your shell environment.');
  }

  console.log('Running migrations...');

  // Enable pgvector extension (required for description_embedding column)
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  await sql`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      modality TEXT,
      context_length INTEGER,
      max_completion_tokens INTEGER,
      input_price_per_1k NUMERIC(18,10),
      output_price_per_1k NUMERIC(18,10),
      image_price_per_1k NUMERIC(18,10),
      created_at TIMESTAMPTZ,
      provider_expiration_at TIMESTAMPTZ,
      supported_parameters TEXT[],
      metadata JSONB NOT NULL DEFAULT '{}',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ,
      retired_at TIMESTAMPTZ,
      description_embedding vector(1536),
      is_available BOOLEAN NOT NULL DEFAULT TRUE
    )
  `;

  // Idempotent ALTER TABLE for deployments where the table already exists
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS description TEXT`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS modality TEXT`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS max_completion_tokens INTEGER`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS image_price_per_1k NUMERIC(18,10)`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS provider_expiration_at TIMESTAMPTZ`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS supported_parameters TEXT[]`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS description_embedding vector(1536)`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE`;

  await sql`
    UPDATE models
    SET provider_expiration_at = COALESCE(
      provider_expiration_at,
      CASE
        WHEN metadata ? 'expiration_date' AND NULLIF(metadata->>'expiration_date', '') IS NOT NULL
          THEN (metadata->>'expiration_date')::timestamptz
        ELSE NULL
      END
    )
    WHERE provider_expiration_at IS NULL
  `;

  await sql`
    UPDATE models
    SET last_seen_at = COALESCE(last_seen_at, fetched_at)
    WHERE last_seen_at IS NULL
  `;

  await sql`
    UPDATE models
    SET retired_at = COALESCE(retired_at, fetched_at)
    WHERE is_available = FALSE AND retired_at IS NULL
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS models_provider_idx ON models(provider)
  `;

  // GIN index for fast containment queries on supported_parameters (e.g. 'tools' = ANY(...))
  await sql`
    CREATE INDEX IF NOT EXISTS models_supported_params_gin_idx
    ON models USING gin(supported_parameters)
  `;

  // HNSW index for fast cosine-similarity search on description embeddings
  await sql`
    CREATE INDEX IF NOT EXISTS models_embedding_hnsw_idx
    ON models USING hnsw (description_embedding vector_cosine_ops)
  `;

  // Partial index for fast queries filtering on availability
  await sql`
    CREATE INDEX IF NOT EXISTS models_available_idx ON models(provider)
    WHERE is_available = TRUE
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_successful_sync TIMESTAMPTZ,
      last_attempted_sync TIMESTAMPTZ,
      last_error TEXT,
      record_count INTEGER NOT NULL DEFAULT 0
    )
  `;

  await sql`
    INSERT INTO sync_status (id, record_count) VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `;

  // Sync history log — one row per sync ATTEMPT, opened as 'running' when the
  // attempt starts and updated in place when it finishes. `success` is NULL
  // while running, so a `success = FALSE` row is always a genuine failure.
  // `status` is deliberately nullable with NO default. Every writer in the
  // current build sets it explicitly, so a default would only ever apply to a
  // row written by an OLDER build — which inserts (synced_at, success,
  // record_count, error) and nothing else. A default of 'running' would stamp
  // those rows as in-flight, and rowToSyncHistoryEntry short-circuits on a
  // non-NULL status, so a successful sync would be reported as one whose
  // process died. Leaving it NULL lets the reader's legacy inference classify
  // them from `success`, which is exactly what it is there for.
  await sql`
    CREATE TABLE IF NOT EXISTS sync_history (
      id BIGSERIAL PRIMARY KEY,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT,
      success BOOLEAN,
      record_count INTEGER,
      error TEXT,
      finished_at TIMESTAMPTZ,
      partial BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;

  // Idempotent upgrade for deployments created before the lifecycle columns.
  await sql`ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS status TEXT`;
  await sql`ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`;
  // `partial` marks a run that updated the catalogue but skipped the retirement
  // sweep because the upstream response looked truncated.
  await sql`ALTER TABLE sync_history ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE sync_history ALTER COLUMN success DROP NOT NULL`;
  // Both must be dropped before the passes below, which write NULL into status.
  await sql`ALTER TABLE sync_history ALTER COLUMN status DROP DEFAULT`;
  await sql`ALTER TABLE sync_history ALTER COLUMN status DROP NOT NULL`;

  // Snapshot before anything below touches a row.
  //
  // The passes that follow include the one destructive statement in this file.
  // The rows it removes are write artefacts of the defect this release fixes and
  // carry nothing their surviving partner does not, but "irreversible" is a poor
  // property for a migration people run casually, and this table is small enough
  // that insurance is free.
  //
  // IF NOT EXISTS is load-bearing: on a re-run it must preserve the ORIGINAL
  // snapshot rather than overwrite it with already-migrated data. To restore:
  //   DELETE FROM sync_history;
  //   INSERT INTO sync_history SELECT * FROM sync_history_pre_lifecycle_backup;
  // Drop the backup table once you are satisfied with the migrated history.
  const legacy = await sql`SELECT COUNT(*)::int AS n FROM sync_history WHERE status IS NULL`;
  const legacyRowCount = legacy.rows[0]?.n ?? 0;
  if (legacyRowCount > 0) {
    await sql`
      CREATE TABLE IF NOT EXISTS sync_history_pre_lifecycle_backup AS
      SELECT * FROM sync_history
    `;
    console.log(
      `  sync_history: ${legacyRowCount} pre-lifecycle rows; snapshot in sync_history_pre_lifecycle_backup`
    );
  }

  // Repair for databases migrated by an earlier revision of this script, which
  // left status defaulting to 'running' and NOT NULL. Rows an older build
  // inserted after that migration took the default, so they carry
  // status = 'running' alongside a real verdict in `success` — a combination the
  // current build never writes, since it clears `success` when it opens an
  // attempt. Clearing status hands them to the backfill passes below.
  await sql`
    UPDATE sync_history
    SET status = NULL
    WHERE status = 'running' AND success IS NOT NULL
  `;

  // Retire the old two-row-per-sync artefact.
  //
  // The previous writer emitted a start marker (success = FALSE, no error, no
  // record count) before contacting OpenRouter, then the real outcome a couple
  // of seconds later. Under the one-row-per-attempt model those markers are
  // duplicates: the outcome row beside each one already records the same
  // attempt. Leaving them would make `get_sync_history` report roughly half of
  // all historical syncs as attempts that died mid-run, which is the opposite
  // of the truth and directly contradicts the tool's own description.
  //
  // A marker is only removed when a completed row follows it within ten
  // minutes; that pairing is what proves it was a marker rather than an attempt
  // that genuinely never finished. The surviving row carries the outcome, the
  // record count and the timestamp — all the marker held beyond that was a
  // start time two seconds earlier. An UNPAIRED marker is left alone and
  // classified 'running' below, which for that row is accurate.
  //
  // This is the one destructive statement in the file. It is deliberate: these
  // rows exist only because of the defect fixed in this release, and no
  // consumer reads them (`get_sync_history` is the sole reader of this table),
  // and the snapshot above makes it reversible.
  const removed = await sql`
    DELETE FROM sync_history marker
    WHERE marker.status IS NULL
      AND marker.success = FALSE
      AND marker.error IS NULL
      AND marker.record_count IS NULL
      AND EXISTS (
        SELECT 1
        FROM sync_history outcome
        WHERE outcome.status IS NULL
          AND (outcome.success = TRUE OR outcome.error IS NOT NULL)
          AND outcome.synced_at > marker.synced_at
          AND outcome.synced_at <= marker.synced_at + INTERVAL '10 minutes'
      )
  `;
  if (removed.rowCount > 0) {
    console.log(`  sync_history: removed ${removed.rowCount} paired start markers left by the old writer`);
  }

  // Backfill in three passes, most specific first. The middle pass now catches
  // only UNPAIRED start markers — attempts the old code opened and never
  // completed — for which 'running' is the honest classification.
  await sql`
    UPDATE sync_history
    SET status = 'success', finished_at = COALESCE(finished_at, synced_at)
    WHERE status IS NULL AND success = TRUE
  `;

  await sql`
    UPDATE sync_history
    SET status = 'running', success = NULL, finished_at = NULL
    WHERE status IS NULL AND success = FALSE AND error IS NULL AND record_count IS NULL
  `;

  await sql`
    UPDATE sync_history
    SET status = 'failure', finished_at = COALESCE(finished_at, synced_at)
    WHERE status IS NULL
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS sync_history_synced_at_idx ON sync_history(synced_at DESC)
  `;

  // Alias table — maps short names (e.g. "sonnet") to canonical model IDs.
  // Created here so that `pnpm db:seed` can insert alias rows without error.
  await sql`
    CREATE TABLE IF NOT EXISTS aliases (
      alias TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'system'
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS aliases_model_id_idx ON aliases(model_id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS admins_username_idx ON admins(username)
  `;

  // OAuth 2.1 dynamic clients (RFC 7591). Persistent so registrations survive
  // across serverless instances and restarts. Public (PKCE) clients have a NULL
  // secret hash; confidential clients store a stable SHA-256 hash.
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret_hash TEXT,
      client_name TEXT NOT NULL DEFAULT 'Anonymous client',
      redirect_uris TEXT[] NOT NULL DEFAULT '{}',
      grant_types TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token'],
      token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
      scope TEXT NOT NULL DEFAULT 'mcp:read',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // OAuth 2.1 authorization codes — short-lived, single-use, PKCE-bound.
  // Only the SHA-256 hash of the code is stored; the row is deleted on redemption.
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT NOT NULL DEFAULT 'S256',
      scope TEXT NOT NULL DEFAULT 'mcp:read',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx
    ON oauth_authorization_codes(expires_at)
  `;

  // Revocation support: a revoked client is rejected at authorize/token time.
  await sql`ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ`;

  // RFC 7592 client management: SHA-256 hash of the registration access token
  // handed to the client once at registration, letting it read or delete its own
  // registration. NULL for clients registered before this column existed.
  await sql`ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS registration_access_token_hash TEXT`;

  // Shared rate-limit counters. Lives in Postgres rather than process memory so
  // a limit is enforced across serverless instances instead of per warm lambda.
  await sql`
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      count INTEGER NOT NULL DEFAULT 0
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx ON rate_limits(window_start)
  `;

  // Per-client MCP usage log — one row per tool call, for usage-by-agent reporting.
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_usage (
      id BIGSERIAL PRIMARY KEY,
      client_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      ok BOOLEAN NOT NULL DEFAULT TRUE,
      called_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS mcp_usage_client_idx ON mcp_usage(client_id)`;
  await sql`CREATE INDEX IF NOT EXISTS mcp_usage_called_at_idx ON mcp_usage(called_at DESC)`;

  console.log('Migrations complete.');
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
