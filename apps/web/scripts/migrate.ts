import { sql } from '@vercel/postgres';

async function migrate() {
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
      metadata JSONB NOT NULL DEFAULT '{}',
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      description_embedding vector(1536)
    )
  `;

  // Idempotent ALTER TABLE for deployments where the table already exists
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS description TEXT`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS modality TEXT`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS max_completion_tokens INTEGER`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS image_price_per_1k NUMERIC(18,10)`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`;
  await sql`ALTER TABLE models ADD COLUMN IF NOT EXISTS description_embedding vector(1536)`;

  await sql`
    CREATE INDEX IF NOT EXISTS models_provider_idx ON models(provider)
  `;

  // HNSW index for fast cosine-similarity search on description embeddings
  await sql`
    CREATE INDEX IF NOT EXISTS models_embedding_hnsw_idx
    ON models USING hnsw (description_embedding vector_cosine_ops)
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
