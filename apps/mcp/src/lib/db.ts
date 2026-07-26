import { sql, db } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow, SyncHistoryEntry, SyncHistoryRow } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus, rowToSyncHistoryEntry } from '@openrouter-mcp/shared';
import type { ModelRepository } from '@openrouter-mcp/shared';

// Whitelist of allowed sort columns mapped to their SQL column names.
// Supports PaginationSchema aliases (newest, context, input_price, output_price),
// raw snake_case column names, and the camelCase spellings used by the Model
// record shape. Used to prevent SQL injection.
const SORT_COLUMN_MAP: Record<string, string> = {
  id: 'id',
  newest: 'created_at',
  context: 'context_length',
  input_price: 'input_price_per_1k',
  output_price: 'output_price_per_1k',
  // raw column aliases kept for internal use
  display_name: 'display_name',
  provider: 'provider',
  context_length: 'context_length',
  max_completion_tokens: 'max_completion_tokens',
  input_price_per_1k: 'input_price_per_1k',
  output_price_per_1k: 'output_price_per_1k',
  image_price_per_1k: 'image_price_per_1k',
  created_at: 'created_at',
  // camelCase spellings matching the Model record fields — callers should not
  // have to remember which casing a given API expects.
  displayName: 'display_name',
  contextLength: 'context_length',
  maxCompletionTokens: 'max_completion_tokens',
  inputPricePer1k: 'input_price_per_1k',
  outputPricePer1k: 'output_price_per_1k',
  imagePricePer1k: 'image_price_per_1k',
  createdAt: 'created_at',
};

// Columns that may contain NULLs and need NULLS LAST appended. Every nullable
// column in the models table is listed under every spelling that maps to it —
// Postgres defaults to NULLS FIRST for DESC, so omitting one puts the rows with
// no value at the top of a "largest/most expensive first" page.
const NULLABLE_SORT_COLUMNS = new Set([
  'newest', 'context', 'input_price', 'output_price',
  'created_at', 'context_length', 'max_completion_tokens',
  'input_price_per_1k', 'output_price_per_1k', 'image_price_per_1k',
  // camelCase spellings of the same columns
  'createdAt', 'contextLength', 'maxCompletionTokens',
  'inputPricePer1k', 'outputPricePer1k', 'imagePricePer1k',
]);

export type SortBy = keyof typeof SORT_COLUMN_MAP;

function resolveOrderBy(sortBy?: string): string {
  const key = sortBy ?? '';
  // Own-property lookup only: a bare index would resolve inherited members such
  // as 'constructor' or 'toString' to a non-nullish value, letting a spelling
  // that is not in the whitelist reach the interpolated ORDER BY clause.
  if (!Object.prototype.hasOwnProperty.call(SORT_COLUMN_MAP, key)) return 'id';
  return SORT_COLUMN_MAP[key] ?? 'id';
}

function resolveOrderDirection(sortDir?: string): 'ASC' | 'DESC' {
  return sortDir === 'desc' ? 'DESC' : 'ASC';
}

function resolveNullsClause(sortBy?: string): string {
  return NULLABLE_SORT_COLUMNS.has(sortBy ?? '') ? ' NULLS LAST' : '';
}

/** Filters understood by both `getModels` and `getModelsCount`. */
export interface ModelFilter {
  provider?: string;
  query?: string;
  toolsOnly?: boolean;
  reasoningOnly?: boolean;
  availableOnly?: boolean;
  retiredOnly?: boolean;
}

/**
 * Builds the WHERE clause and its positional parameters for the `models` table.
 * Shared by the page query and the matching-row count query so the two can
 * never disagree about what "matching" means. Callers append their own
 * parameters (LIMIT/OFFSET) after the ones returned here.
 */
function buildModelWhere(opts: ModelFilter): { where: string; params: (string | number | null)[] } {
  const { provider, query, toolsOnly, reasoningOnly, availableOnly, retiredOnly } = opts;
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (provider) {
    params.push(provider);
    conditions.push(`provider = $${params.length}`);
  }
  if (query) {
    const likeQuery = `%${query}%`;
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

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function getModels(
  opts: ModelFilter & {
    /** Omit to return every matching row — no LIMIT clause is emitted. */
    limit?: number;
    offset: number;
    sortBy?: string;
    sortDir?: string;
  }
): Promise<Model[]> {
  const { limit, offset, sortBy, sortDir } = opts;
  const orderCol = resolveOrderBy(sortBy);
  const orderDir = resolveOrderDirection(sortDir);
  const nullsClause = resolveNullsClause(sortBy);

  const { where, params } = buildModelWhere(opts);

  // `limit` is optional so a caller can pull the whole catalogue in one query.
  // Each placeholder is numbered from params.length *after* its value is pushed,
  // so the numbering stays correct whichever clauses are present.
  let pagination = '';
  if (limit != null) {
    params.push(limit);
    pagination += ` LIMIT $${params.length}`;
  }
  if (offset > 0) {
    params.push(offset);
    pagination += ` OFFSET $${params.length}`;
  }

  const queryStr = `SELECT * FROM models ${where} ORDER BY ${orderCol} ${orderDir}${nullsClause}${pagination}`;

  const result = await db.query<ModelRow>(queryStr, params);
  return result.rows.map(rowToModel);
}

/** Number of rows matching the same filters as `getModels`, ignoring limit/offset. */
export async function getModelsCount(opts: ModelFilter): Promise<number> {
  const { where, params } = buildModelWhere(opts);
  const queryStr = `SELECT COUNT(*)::text AS count FROM models ${where}`;

  const result = await db.query<{ count: string }>(queryStr, params);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Live row counts straight from the `models` table. Lets callers reconcile
 * list results against `sync_status.record_count`, which only counts the models
 * present in the last successful sync and therefore excludes retired rows.
 */
export async function getModelCounts(): Promise<{ total: number; available: number; retired: number }> {
  const result = await db.query<{ total: string; available: string; retired: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE is_available)::text AS available,
            COUNT(*) FILTER (WHERE NOT is_available)::text AS retired
     FROM models`
  );
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? 0),
    available: Number(row?.available ?? 0),
    retired: Number(row?.retired ?? 0),
  };
}

export async function getModelById(id: string): Promise<Model | null> {
  const result = await db.query<ModelRow>(
    'SELECT * FROM models WHERE LOWER(id) = LOWER($1) LIMIT 1',
    [id]
  );
  return result.rows[0] ? rowToModel(result.rows[0]) : null;
}

export async function getProviders(): Promise<string[]> {
  const result = await db.query<{ provider: string }>(
    `SELECT DISTINCT provider FROM models
     WHERE provider IS NOT NULL AND provider != ''
     ORDER BY provider`
  );
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

/** Filters understood by both `findModelsByCriteria` and `findModelsByCriteriaCount`. */
export interface ModelCriteria {
  maxInputPricePer1k?: number;
  maxOutputPricePer1k?: number;
  minContextLength?: number;
  modality?: string;
}

/**
 * Builds the WHERE clause and its positional parameters for the criteria
 * search. Shared by the page query and its matching-row count query. NULL
 * prices pass the price filters — they are treated as free/unknown.
 */
function buildCriteriaWhere(opts: ModelCriteria): { where: string; params: (string | number | null)[] } {
  const { maxInputPricePer1k, maxOutputPricePer1k, minContextLength, modality } = opts;
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

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

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

export async function findModelsByCriteria(
  opts: ModelCriteria & {
    limit: number;
    offset: number;
    sortBy?: string;
    sortDir?: string;
  }
): Promise<Model[]> {
  const { limit, offset, sortBy, sortDir } = opts;
  const orderCol = resolveOrderBy(sortBy);
  const orderDir = resolveOrderDirection(sortDir);
  const nullsClause = resolveNullsClause(sortBy);

  const { where, params } = buildCriteriaWhere(opts);
  params.push(limit, offset);
  const query = `SELECT * FROM models ${where} ORDER BY ${orderCol} ${orderDir}${nullsClause} LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await db.query<ModelRow>(query, params);
  return result.rows.map(rowToModel);
}

/** Number of rows matching the same criteria as `findModelsByCriteria`, ignoring limit/offset. */
export async function findModelsByCriteriaCount(opts: ModelCriteria): Promise<number> {
  const { where, params } = buildCriteriaWhere(opts);
  const query = `SELECT COUNT(*)::text AS count FROM models ${where}`;

  const result = await db.query<{ count: string }>(query, params);
  return Number(result.rows[0]?.count ?? 0);
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
               created_at, provider_expiration_at, supported_parameters, metadata,
               fetched_at, last_seen_at, retired_at, is_available
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NULL, TRUE)
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
               provider_expiration_at = EXCLUDED.provider_expiration_at,
               supported_parameters = EXCLUDED.supported_parameters,
               metadata = EXCLUDED.metadata,
               fetched_at = EXCLUDED.fetched_at,
               last_seen_at = EXCLUDED.last_seen_at,
               retired_at = NULL,
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
              model.providerExpirationAt?.toISOString() ?? null,
              model.supportedParameters,
              JSON.stringify(model.metadata),
              model.fetchedAt.toISOString(),
              model.lastSeenAt?.toISOString() ?? null,
            ]
          );
        }

        // Mark models no longer returned by OpenRouter as unavailable
        for (const provider of providers) {
          await client.query(
            `UPDATE models
             SET is_available = FALSE,
                 retired_at = COALESCE(retired_at, $2::timestamptz)
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
