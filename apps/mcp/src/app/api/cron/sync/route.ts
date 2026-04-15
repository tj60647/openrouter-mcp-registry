import { NextRequest, NextResponse } from 'next/server';
import { ModelSyncService, OpenRouterProvider, logger } from '@openrouter-mcp/shared';
import { createModelRepository } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Vercel cron sends CRON_SECRET as Authorization header
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
    const repository = createModelRepository();
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
