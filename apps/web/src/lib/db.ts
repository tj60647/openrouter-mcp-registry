import { sql } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus } from '@openrouter-mcp/shared';

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

export async function getSyncStatus(): Promise<SyncStatus | null> {
  const result = await sql<SyncStatusRow>`
    SELECT * FROM sync_status ORDER BY id DESC LIMIT 1
  `;
  return result.rows[0] ? rowToSyncStatus(result.rows[0]) : null;
}
