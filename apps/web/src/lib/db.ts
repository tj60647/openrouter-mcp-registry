import { sql, db } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus } from '@openrouter-mcp/shared';

// Whitelist mapping of safe sort-by names to their ORDER BY SQL fragments.
const SORT_ORDER_MAP: Record<string, string> = {
  id: 'id ASC',
  newest: 'created_at DESC NULLS LAST',
  context: 'context_length DESC NULLS LAST',
  input_price: 'input_price_per_1k ASC NULLS LAST',
  output_price: 'output_price_per_1k ASC NULLS LAST',
};

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
  toolsOnly?: boolean;
  reasoningOnly?: boolean;
}): Promise<Model[]> {
  const { limit, offset, provider, query, sortBy, toolsOnly, reasoningOnly } = opts;
  const likeQuery = query ? `%${query}%` : null;
  const orderSql = SORT_ORDER_MAP[sortBy ?? ''] ?? 'id ASC';

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
}): Promise<number> {
  const { provider, query, toolsOnly, reasoningOnly } = opts;
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
