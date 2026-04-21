import { sql, db } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow, SyncHistoryEntry, SyncHistoryRow } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus, rowToSyncHistoryEntry } from '@openrouter-mcp/shared';
import type { ModelRepository } from '@openrouter-mcp/shared';

// Whitelist of allowed sort columns mapped to their SQL column names.
// Used by getModels and findModelsByCriteria to prevent SQL injection.
const SORT_COLUMN_MAP: Record<string, string> = {
  id: 'id',
  display_name: 'display_name',
  provider: 'provider',
  context_length: 'context_length',
  max_completion_tokens: 'max_completion_tokens',
  input_price_per_1k: 'input_price_per_1k',
  output_price_per_1k: 'output_price_per_1k',
  image_price_per_1k: 'image_price_per_1k',
  created_at: 'created_at',
};

export type SortBy = keyof typeof SORT_COLUMN_MAP;

function resolveOrderBy(sortBy?: string): string {
  return SORT_COLUMN_MAP[sortBy ?? ''] ?? 'id';
}

export async function getModels(opts: {
  limit: number;
  offset: number;
  provider?: string;
  query?: string;
  sortBy?: string;
  availableOnly?: boolean;
}): Promise<Model[]> {
  const { limit, offset, provider, query, sortBy, availableOnly } = opts;
  const likeQuery = query ? `%${query}%` : null;
  const orderCol = resolveOrderBy(sortBy);

  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (provider) {
    params.push(provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (likeQuery) {
    params.push(likeQuery, likeQuery, likeQuery);
    const n = params.length;
    conditions.push(`(id ILIKE $${n - 2} OR display_name ILIKE $${n - 1} OR provider ILIKE $${n})`);
  }
  if (availableOnly) {
    conditions.push(`is_available = TRUE`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const queryStr = `SELECT * FROM models ${where} ORDER BY ${orderCol} LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await db.query<ModelRow>(queryStr, params);
  return result.rows.map(rowToModel);
}

export async function getModelsCount(opts: {
  provider?: string;
  query?: string;
  availableOnly?: boolean;
}): Promise<number> {
  const { provider, query, availableOnly } = opts;
  const likeQuery = query ? `%${query}%` : null;

  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (provider) {
    params.push(provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (likeQuery) {
    params.push(likeQuery, likeQuery, likeQuery);
    const n = params.length;
    conditions.push(`(id ILIKE $${n - 2} OR display_name ILIKE $${n - 1} OR provider ILIKE $${n})`);
  }
  if (availableOnly) {
    conditions.push(`is_available = TRUE`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const queryStr = `SELECT COUNT(*)::text AS count FROM models ${where}`;

  const result = await db.query<{ count: string }>(queryStr, params);
  return Number(result.rows[0]?.count ?? 0);
}

export async function getModelById(id: string): Promise<Model | null> {
  const result = await db.query<ModelRow>(
    'SELECT * FROM models WHERE LOWER(id) = LOWER($1) LIMIT 1',
    [id]
  );
  return result.rows[0] ? rowToModel(result.rows[0]) : null;
}

export async function getSyncStatus(): Promise<SyncStatus | null> {
  const result = await sql<SyncStatusRow>`
    SELECT * FROM sync_status ORDER BY id DESC LIMIT 1
  `;
  return result.rows[0] ? rowToSyncStatus(result.rows[0]) : null;
}

export async function getSyncHistory(limit = 50): Promise<SyncHistoryEntry[]> {
  const result = await db.query<SyncHistoryRow>(
    `SELECT id, synced_at, success, record_count, error
     FROM sync_history
     ORDER BY synced_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(rowToSyncHistoryEntry);
}

export async function findModelsByCriteria(opts: {
  maxInputPricePer1k?: number;
  maxOutputPricePer1k?: number;
  minContextLength?: number;
  modality?: string;
  limit: number;
  offset: number;
  sortBy?: string;
}): Promise<Model[]> {
  const { maxInputPricePer1k, maxOutputPricePer1k, minContextLength, modality, limit, offset, sortBy } = opts;
  const orderCol = resolveOrderBy(sortBy);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (maxInputPricePer1k != null) {
    params.push(maxInputPricePer1k);
    conditions.push(`(input_price_per_1k IS NULL OR input_price_per_1k <= $${params.length})`);
  }
  if (maxOutputPricePer1k != null) {
    params.push(maxOutputPricePer1k);
    conditions.push(`(output_price_per_1k IS NULL OR output_price_per_1k <= $${params.length})`);
  }
  if (minContextLength != null) {
    params.push(minContextLength);
    conditions.push(`context_length >= $${params.length}`);
  }
  if (modality) {
    params.push(`%${modality}%`);
    conditions.push(`modality ILIKE $${params.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const query = `SELECT * FROM models ${where} ORDER BY ${orderCol} LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await db.query<ModelRow>(query, params as (string | number | null)[]);
  return result.rows.map(rowToModel);
}

export async function semanticSearchModels(opts: {
  embedding: number[];
  limit: number;
  offset: number;
}): Promise<Model[]> {
  const { embedding, limit, offset } = opts;
  const embeddingLiteral = `[${embedding.join(',')}]`;
  const result = await db.query<ModelRow>(
    `SELECT * FROM models
     WHERE description_embedding IS NOT NULL
     ORDER BY description_embedding <=> $1
     LIMIT $2 OFFSET $3`,
    [embeddingLiteral, limit, offset]
  );
  return result.rows.map(rowToModel);
}

export async function getToolCapableModels(limit = 20): Promise<Model[]> {
  const result = await db.query<ModelRow>(
    `SELECT * FROM models
     WHERE 'tools' = ANY(supported_parameters)
       AND modality ILIKE '%text%'
     ORDER BY created_at DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(rowToModel);
}

export function createModelRepository(): ModelRepository {
  return {
    async upsertModels(models: Model[]): Promise<void> {
      const syncStartedAt = models[0]?.fetchedAt ?? new Date();
      const providers = Array.from(new Set(models.map((m) => m.provider).filter(Boolean)));

      // Uses individual upserts within a transaction to maintain atomicity.
      // client.query with positional parameters is required here because the @vercel/postgres
      // sql tagged template does not support JavaScript arrays (e.g. string[]) as bind
      // parameters — it would serialize them as strings rather than Postgres array literals.
      // Using client.query lets the pg driver handle proper TEXT[] array binding for
      // supported_parameters.
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        for (const model of models) {
          await client.query(
            `INSERT INTO models (
               id, provider, display_name, description, modality,
               context_length, max_completion_tokens,
               input_price_per_1k, output_price_per_1k, image_price_per_1k,
               created_at, supported_parameters, metadata, fetched_at, is_available
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
             ON CONFLICT (id) DO UPDATE SET
               provider = EXCLUDED.provider,
               display_name = EXCLUDED.display_name,
               description = EXCLUDED.description,
               modality = EXCLUDED.modality,
               context_length = EXCLUDED.context_length,
               max_completion_tokens = EXCLUDED.max_completion_tokens,
               input_price_per_1k = EXCLUDED.input_price_per_1k,
               output_price_per_1k = EXCLUDED.output_price_per_1k,
               image_price_per_1k = EXCLUDED.image_price_per_1k,
               created_at = EXCLUDED.created_at,
               supported_parameters = EXCLUDED.supported_parameters,
               metadata = EXCLUDED.metadata,
               fetched_at = EXCLUDED.fetched_at,
               is_available = TRUE,
               description_embedding = CASE
                 WHEN models.description IS DISTINCT FROM EXCLUDED.description THEN NULL
                 ELSE models.description_embedding
               END`,
            [
              model.id,
              model.provider,
              model.displayName,
              model.description,
              model.modality,
              model.contextLength,
              model.maxCompletionTokens,
              model.inputPricePer1k,
              model.outputPricePer1k,
              model.imagePricePer1k,
              model.createdAt?.toISOString() ?? null,
              model.supportedParameters,
              JSON.stringify(model.metadata),
              model.fetchedAt.toISOString(),
            ]
          );
        }

        // Mark models no longer returned by OpenRouter as unavailable
        for (const provider of providers) {
          await client.query(
            `UPDATE models
             SET is_available = FALSE
             WHERE provider = $1::text
               AND fetched_at < $2::timestamptz`,
            [provider, syncStartedAt.toISOString()]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async recordSyncAttempt(success: boolean, error?: string, count?: number): Promise<void> {
      const now = new Date().toISOString();
      if (success) {
        await sql`
          INSERT INTO sync_status (id, last_successful_sync, last_attempted_sync, last_error, record_count)
          VALUES (1, ${now}, ${now}, NULL, ${count ?? 0})
          ON CONFLICT (id) DO UPDATE SET
            last_successful_sync = EXCLUDED.last_successful_sync,
            last_attempted_sync = EXCLUDED.last_attempted_sync,
            last_error = NULL,
            record_count = EXCLUDED.record_count
        `;
      } else {
        await sql`
          INSERT INTO sync_status (id, last_attempted_sync, last_error, record_count)
          VALUES (1, ${now}, ${error ?? null}, 0)
          ON CONFLICT (id) DO UPDATE SET
            last_attempted_sync = EXCLUDED.last_attempted_sync,
            last_error = EXCLUDED.last_error
        `;
      }
      // Append an immutable record to the history log
      await db.query(
        `INSERT INTO sync_history (synced_at, success, record_count, error)
         VALUES ($1, $2, $3, $4)`,
        [now, success, success ? (count ?? 0) : null, error ?? null]
      );
    },

    async acquireSyncLock(): Promise<boolean> {
      try {
        const result = await sql<{ acquired: boolean }>`
          SELECT pg_try_advisory_lock(12345678) as acquired
        `;
        return result.rows[0]?.acquired ?? false;
      } catch {
        return false;
      }
    },

    async releaseSyncLock(): Promise<void> {
      try {
        await sql`SELECT pg_advisory_unlock(12345678)`;
      } catch {
        // best-effort
      }
    },
  };
}
