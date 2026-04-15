import { sql, db } from '@vercel/postgres';
import type { Model, ModelRow, SyncStatus, SyncStatusRow } from '@openrouter-mcp/shared';
import { rowToModel, rowToSyncStatus } from '@openrouter-mcp/shared';
import type { ModelRepository } from '@openrouter-mcp/shared';

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

export async function getModelById(id: string): Promise<Model | null> {
  const result = await sql<ModelRow>`
    SELECT * FROM models WHERE id = ${id} LIMIT 1
  `;
  return result.rows[0] ? rowToModel(result.rows[0]) : null;
}

export async function getSyncStatus(): Promise<SyncStatus | null> {
  const result = await sql<SyncStatusRow>`
    SELECT * FROM sync_status ORDER BY id DESC LIMIT 1
  `;
  return result.rows[0] ? rowToSyncStatus(result.rows[0]) : null;
}

export async function resolveAlias(alias: string): Promise<string | null> {
  const result = await sql<{ model_id: string }>`
    SELECT model_id FROM aliases WHERE alias = ${alias} LIMIT 1
  `;
  return result.rows[0]?.model_id ?? null;
}

export function createModelRepository(): ModelRepository {
  return {
    async upsertModels(models: Model[]): Promise<void> {
      // Uses individual upserts within a transaction to maintain atomicity.
      // Each upsert uses parameterized queries via the sql tag to prevent injection.
      const client = await db.connect();
      try {
        await client.sql`BEGIN`;
        for (const model of models) {
          await client.sql`
            INSERT INTO models (id, provider, display_name, context_length, input_price_per_1k, output_price_per_1k, metadata, fetched_at)
            VALUES (
              ${model.id},
              ${model.provider},
              ${model.displayName},
              ${model.contextLength},
              ${model.inputPricePer1k},
              ${model.outputPricePer1k},
              ${JSON.stringify(model.metadata)},
              ${model.fetchedAt.toISOString()}
            )
            ON CONFLICT (id) DO UPDATE SET
              provider = EXCLUDED.provider,
              display_name = EXCLUDED.display_name,
              context_length = EXCLUDED.context_length,
              input_price_per_1k = EXCLUDED.input_price_per_1k,
              output_price_per_1k = EXCLUDED.output_price_per_1k,
              metadata = EXCLUDED.metadata,
              fetched_at = EXCLUDED.fetched_at
          `;
        }
        await client.sql`COMMIT`;
      } catch (err) {
        await client.sql`ROLLBACK`;
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
