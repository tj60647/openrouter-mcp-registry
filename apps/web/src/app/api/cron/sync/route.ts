import { NextRequest, NextResponse } from 'next/server';
import { ModelSyncService, OpenRouterProvider, logger } from '@openrouter-mcp/shared';
import type { Model, ModelRepository } from '@openrouter-mcp/shared';
import { sql } from '@vercel/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function createWebModelRepository(): ModelRepository {
  return {
    async upsertModels(models: Model[]): Promise<void> {
      const syncStartedAt = models[0]?.fetchedAt ?? new Date();
      const providers = Array.from(new Set(models.map((m) => m.provider).filter(Boolean)));

      await sql`BEGIN`;
      try {
        for (const model of models) {
          await sql`
            INSERT INTO models (
              id, provider, display_name, description, modality,
              context_length, max_completion_tokens,
              input_price_per_1k, output_price_per_1k, image_price_per_1k,
              created_at, metadata, fetched_at
            )
            VALUES (
              ${model.id}, ${model.provider}, ${model.displayName},
              ${model.description}, ${model.modality},
              ${model.contextLength}, ${model.maxCompletionTokens},
              ${model.inputPricePer1k}, ${model.outputPricePer1k}, ${model.imagePricePer1k},
              ${model.createdAt?.toISOString() ?? null},
              ${JSON.stringify(model.metadata)}, ${model.fetchedAt.toISOString()}
            )
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
              metadata = EXCLUDED.metadata,
              fetched_at = EXCLUDED.fetched_at,
              description_embedding = CASE
                WHEN models.description IS DISTINCT FROM EXCLUDED.description THEN NULL
                ELSE models.description_embedding
              END
          `;
        }

        for (const provider of providers) {
          await sql`
            UPDATE models
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              '_stale', true,
              '_staleAt', NOW()
            )
            WHERE provider = ${provider}::text
              AND fetched_at < ${syncStartedAt.toISOString()}::timestamptz
          `;
        }

        await sql`COMMIT`;
      } catch (err) {
        await sql`ROLLBACK`;
        throw err;
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
        const r = await sql<{ acquired: boolean }>`SELECT pg_try_advisory_lock(12345678) as acquired`;
        return r.rows[0]?.acquired ?? false;
      } catch { return false; }
    },
    async releaseSyncLock(): Promise<void> {
      try { await sql`SELECT pg_advisory_unlock(12345678)`; } catch { /* best-effort */ }
    },
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env['CRON_SECRET'];
  if (cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENROUTER_API_KEY not configured' }, { status: 503 });
    }

    const provider = new OpenRouterProvider(apiKey);
    const repository = createWebModelRepository();
    const syncService = new ModelSyncService(provider, repository);

    logger.info('Cron sync started');
    const result = await syncService.sync();
    logger.info('Cron sync completed', { result });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Cron sync failed', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
