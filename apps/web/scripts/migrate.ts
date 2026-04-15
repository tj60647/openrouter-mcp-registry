import { sql } from '@vercel/postgres';

async function migrate() {
  console.log('Running migrations...');

  await sql`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_length INTEGER,
      input_price_per_1k NUMERIC(18,10),
      output_price_per_1k NUMERIC(18,10),
      metadata JSONB NOT NULL DEFAULT '{}',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS models_provider_idx ON models(provider)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS aliases (
      alias TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'system' CHECK (scope IN ('system', 'org')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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

  console.log('Migrations complete.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
