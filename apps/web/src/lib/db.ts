import { sql } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus } from '@openrouter-mcp/shared';

export async function getModels(opts: {
  limit: number;
  offset: number;
  provider?: string;
}): Promise<Model[]> {
  const { limit, offset, provider } = opts;
  let result;
  if (provider) {
    result = await sql<ModelRow>`
      SELECT * FROM models WHERE provider = ${provider}
      ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    result = await sql<ModelRow>`
      SELECT * FROM models ORDER BY id LIMIT ${limit} OFFSET ${offset}
    `;
  }
  return result.rows.map(rowToModel);
}

export async function getSyncStatus(): Promise<SyncStatus | null> {
  const result = await sql<SyncStatusRow>`
    SELECT * FROM sync_status ORDER BY id DESC LIMIT 1
  `;
  return result.rows[0] ? rowToSyncStatus(result.rows[0]) : null;
}
