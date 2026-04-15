import { NextRequest, NextResponse } from 'next/server';
import { RefreshRequestSchema, ModelSyncService, OpenRouterProvider } from '@openrouter-mcp/shared';
import { createModelRepository } from '../../../../lib/db';
import { validateAdminToken } from '../../../../lib/auth';
import { logger } from '@openrouter-mcp/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authError = validateAdminToken(req);
  if (authError) return authError;

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = RefreshRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      return NextResponse.json({ error: 'OPENROUTER_API_KEY not configured' }, { status: 503 });
    }

    const provider = new OpenRouterProvider(apiKey);
    const repository = createModelRepository();
    const syncService = new ModelSyncService(provider, repository);

    logger.info('Manual refresh triggered', { force: parsed.data.force });
    const result = await syncService.sync({ force: parsed.data.force });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Refresh failed', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
