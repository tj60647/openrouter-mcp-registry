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
  const { maxInputPricePer1k, maxOutputPricePer1k, minContextLength, limit, offset } = opts;

  // Build query dynamically; models with NULL prices are treated as no-cost / unknown
  if (maxInputPricePer1k !== undefined && maxOutputPricePer1k !== undefined && minContextLength !== undefined) {
    const result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE (input_price_per_1k IS NULL OR input_price_per_1k <= ${maxInputPricePer1k})
        AND (output_price_per_1k IS NULL OR output_price_per_1k <= ${maxOutputPricePer1k})
        AND (context_length IS NULL OR context_length >= ${minContextLength})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  } else if (maxInputPricePer1k !== undefined && maxOutputPricePer1k !== undefined) {
    const result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE (input_price_per_1k IS NULL OR input_price_per_1k <= ${maxInputPricePer1k})
        AND (output_price_per_1k IS NULL OR output_price_per_1k <= ${maxOutputPricePer1k})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  } else if (maxInputPricePer1k !== undefined && minContextLength !== undefined) {
    const result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE (input_price_per_1k IS NULL OR input_price_per_1k <= ${maxInputPricePer1k})
        AND (context_length IS NULL OR context_length >= ${minContextLength})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  } else if (maxOutputPricePer1k !== undefined && minContextLength !== undefined) {
    const result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE (output_price_per_1k IS NULL OR output_price_per_1k <= ${maxOutputPricePer1k})
        AND (context_length IS NULL OR context_length >= ${minContextLength})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  } else if (maxInputPricePer1k !== undefined) {
    const result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE (input_price_per_1k IS NULL OR input_price_per_1k <= ${maxInputPricePer1k})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  } else if (maxOutputPricePer1k !== undefined) {
    const result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE (output_price_per_1k IS NULL OR output_price_per_1k <= ${maxOutputPricePer1k})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  } else if (minContextLength !== undefined) {
    const result = await sql<ModelRow>`
      SELECT * FROM models
      WHERE (context_length IS NULL OR context_length >= ${minContextLength})
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  } else {
    const result = await sql<ModelRow>`
      SELECT * FROM models ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
    return result.rows.map(rowToModel);
  }
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
