import { sql } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus } from '@openrouter-mcp/shared';

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
}): Promise<Model[]> {
  const { limit, offset, provider, query } = opts;
  const likeQuery = query ? `%${query}%` : null;
  let result;
  if (provider && likeQuery) {
    result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE provider = ${provider}
        AND (id ILIKE ${likeQuery} OR display_name ILIKE ${likeQuery} OR provider ILIKE ${likeQuery})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (provider) {
    result = await sql<ModelRow>`
      SELECT * FROM models WHERE provider = ${provider}
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (likeQuery) {
    result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE id ILIKE ${likeQuery} OR display_name ILIKE ${likeQuery} OR provider ILIKE ${likeQuery}
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    result = await sql<ModelRow>`
      SELECT * FROM models ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
  }
  return result.rows.map(rowToModel);
}

export async function getModelsCount(opts: {
  provider?: string;
  query?: string;
}): Promise<number> {
  const { provider, query } = opts;
  const likeQuery = query ? `%${query}%` : null;
  let result;

  if (provider && likeQuery) {
    result = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM models
      WHERE provider = ${provider}
        AND (id ILIKE ${likeQuery} OR display_name ILIKE ${likeQuery} OR provider ILIKE ${likeQuery})
    `;
  } else if (provider) {
    result = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM models WHERE provider = ${provider}
    `;
  } else if (likeQuery) {
    result = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM models
      WHERE id ILIKE ${likeQuery} OR display_name ILIKE ${likeQuery} OR provider ILIKE ${likeQuery}
    `;
  } else {
    result = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM models
    `;
  }

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
