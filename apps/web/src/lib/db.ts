import { sql, db } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow, SyncHistoryEntry, SyncHistoryRow, ModelRepository } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus, rowToSyncHistoryEntry } from '@openrouter-mcp/shared';

// Whitelist mapping of safe sort-by column names to their SQL column expressions.
// Direction (ASC/DESC) and NULLS LAST are applied dynamically based on sortDir param.
const SORT_COLUMN_MAP: Record<string, string> = {
  id: 'id',
  newest: 'created_at',
  context: 'context_length',
  input_price: 'input_price_per_1k',
  output_price: 'output_price_per_1k',
};
// Columns that may contain NULLs and need NULLS LAST appended.
const NULLABLE_SORT_COLUMNS = new Set(['newest', 'context', 'input_price', 'output_price']);

function buildOrderSql(sortBy: string | undefined, sortDir: string | undefined): string {
  const col = SORT_COLUMN_MAP[sortBy ?? 'id'] ?? 'id';
  const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
  const nulls = NULLABLE_SORT_COLUMNS.has(sortBy ?? '') ? ' NULLS LAST' : '';
  return `${col} ${dir}${nulls}`;
}

export async function getModelById(id: string): Promise<Model | null> {
  const result = await sql<ModelRow>`SELECT * FROM models WHERE id = ${id} LIMIT 1`;
  return result.rows[0] ? rowToModel(result.rows[0]) : null;
}

export async function findModelsByCriteria(opts: {
  maxInputPricePer1k?: number;
  maxOutputPricePer1k?: number;
  minContextLength?: number;
  limit: number;
  offset: number;
}): Promise<Model[]> {
  const {
    maxInputPricePer1k = null,
    maxOutputPricePer1k = null,
    minContextLength = null,
    limit,
    offset,
  } = opts;

  // When a parameter is null the condition is bypassed (IS NULL short-circuits).
  // Models with NULL prices are treated as free / unknown (always pass the filter).
  const result = await sql<ModelRow>`
    SELECT * FROM models
    WHERE
      (${maxInputPricePer1k}::numeric IS NULL OR input_price_per_1k IS NULL OR input_price_per_1k <= ${maxInputPricePer1k})
      AND (${maxOutputPricePer1k}::numeric IS NULL OR output_price_per_1k IS NULL OR output_price_per_1k <= ${maxOutputPricePer1k})
      AND (${minContextLength}::integer IS NULL OR context_length IS NULL OR context_length >= ${minContextLength})
    ORDER BY id LIMIT ${limit} OFFSET ${offset}
  `;
  return result.rows.map(rowToModel);
}

export async function getModels(opts: {
  limit: number;
  offset: number;
  provider?: string;
  query?: string;
  sortBy?: string;
  sortDir?: string;
  toolsOnly?: boolean;
  reasoningOnly?: boolean;
  availableOnly?: boolean;
  retiredOnly?: boolean;
}): Promise<Model[]> {
  const { limit, offset, provider, query, sortBy, sortDir, toolsOnly, reasoningOnly, availableOnly, retiredOnly } = opts;
  const likeQuery = query ? `%${query}%` : null;
  const orderSql = buildOrderSql(sortBy, sortDir);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (provider) {
    params.push(provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (likeQuery) {
    params.push(likeQuery, likeQuery, likeQuery);
    const n = params.length;
    conditions.push(`(id ILIKE $${n - 2} OR display_name ILIKE $${n - 1} OR provider ILIKE $${n})`);
  }
  if (toolsOnly) {
    conditions.push(`'tools' = ANY(supported_parameters)`);
  }
  if (reasoningOnly) {
    conditions.push(`'reasoning' = ANY(supported_parameters)`);
  }
  if (availableOnly) {
    conditions.push(`is_available = TRUE`);
  }
  if (retiredOnly) {
    conditions.push(`is_available = FALSE`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const queryStr = `SELECT * FROM models ${where} ORDER BY ${orderSql} LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await db.query<ModelRow>(queryStr, params as (string | number | null)[]);
  return result.rows.map(rowToModel);
}

export async function getModelsCount(opts: {
  provider?: string;
  query?: string;
  toolsOnly?: boolean;
  reasoningOnly?: boolean;
  availableOnly?: boolean;
  retiredOnly?: boolean;
}): Promise<number> {
  const { provider, query, toolsOnly, reasoningOnly, availableOnly, retiredOnly } = opts;
  const likeQuery = query ? `%${query}%` : null;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (provider) {
    params.push(provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (likeQuery) {
    params.push(likeQuery, likeQuery, likeQuery);
    const n = params.length;
    conditions.push(`(id ILIKE $${n - 2} OR display_name ILIKE $${n - 1} OR provider ILIKE $${n})`);
  }
  if (toolsOnly) {
    conditions.push(`'tools' = ANY(supported_parameters)`);
  }
  if (reasoningOnly) {
    conditions.push(`'reasoning' = ANY(supported_parameters)`);
  }
  if (availableOnly) {
    conditions.push(`is_available = TRUE`);
  }
  if (retiredOnly) {
    conditions.push(`is_available = FALSE`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const queryStr = `SELECT COUNT(*)::text AS count FROM models ${where}`;

  const result = await db.query<{ count: string }>(queryStr, params as (string | number | null)[]);
  return Number(result.rows[0]?.count ?? 0);
}

export async function getProviders(): Promise<string[]> {
  const result = await sql<{ provider: string }>`
    SELECT DISTINCT provider FROM models
    WHERE provider IS NOT NULL AND provider != ''
    ORDER BY provider
  `;
  return result.rows.map((r) => r.provider);
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

export async function getToolCapableModels(limit = 20): Promise<Model[]> {
  const result = await sql<ModelRow>`
    SELECT * FROM models
    WHERE 'tools' = ANY(supported_parameters)
      AND modality ILIKE '%text%'
    ORDER BY created_at DESC NULLS LAST
    LIMIT ${limit}
  `;
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
