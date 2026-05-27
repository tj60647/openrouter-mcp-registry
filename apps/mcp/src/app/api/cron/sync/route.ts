import { NextRequest, NextResponse } from 'next/server';
import { ModelSyncService, OpenRouterProvider, logger } from '@openrouter-mcp/shared';
import { createModelRepository } from '../../../../lib/db';
import { generatePendingEmbeddings } from '../../../../lib/embeddings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Vercel cron sends CRON_SECRET as Authorization header.
  // In production, the secret must be set — reject unconfigured deployments.
  const cronSecret = process.env['CRON_SECRET'];
  if (!cronSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      logger.error('CRON_SECRET not configured in production');
      return NextResponse.json({ error: 'Cron auth not configured' }, { status: 503 });
    }
  } else {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${cronSecret}`) {
      logger.warn('Cron sync rejected: invalid authorization');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      logger.error('OPENROUTER_API_KEY not configured');
      return NextResponse.json({ error: 'OPENROUTER_API_KEY not configured' }, { status: 503 });
    }

    const provider = new OpenRouterProvider(apiKey);
    const repository = createModelRepository();
    const syncService = new ModelSyncService(provider, repository);

    const syncStart = Date.now();
    logger.info('Cron sync started');
    const result = await syncService.sync();
    const syncDurationMs = Date.now() - syncStart;
    logger.info('Cron sync completed', { durationMs: syncDurationMs, result });

    // Generate embeddings for any models that now have a description but no vector yet.
    // Uses OPENROUTER_API_KEY (already required above) to call openai/text-embedding-3-small via OpenRouter.
    // Guard against Vercel function timeout: skip embeddings if less than 10 seconds remain.
    if (result.success) {
      const elapsed = Date.now() - syncStart;
      const budgetMs = (maxDuration - 10) * 1000; // reserve 10 seconds for response
      if (elapsed < budgetMs) {
        const embStart = Date.now();
        const embeddingsGenerated = await generatePendingEmbeddings(apiKey);
        logger.info('Embeddings generated', { embeddingsGenerated, durationMs: Date.now() - embStart });
        return NextResponse.json({ ...result, embeddingsGenerated });
      } else {
        logger.warn('Skipping embedding generation: insufficient time budget remaining', { elapsedMs: elapsed, budgetMs });
        return NextResponse.json({ ...result, embeddingsGenerated: 0, embeddingsSkipped: true });
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Cron sync failed', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
