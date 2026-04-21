import { NextRequest, NextResponse } from 'next/server';
import { RefreshRequestSchema, ModelSyncService, OpenRouterProvider, logger } from '@openrouter-mcp/shared';
import { createModelRepository } from '../../../../lib/db';
import { generatePendingEmbeddings } from '../../../../lib/embeddings';
import { verifySessionToken, SESSION_COOKIE } from '../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function validateAdminSession(req: NextRequest): Promise<NextResponse | null> {
  const sessionSecret = process.env['ADMIN_SESSION_SECRET'];
  if (!sessionSecret) {
    return NextResponse.json({ error: 'Admin auth not configured' }, { status: 503 });
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySessionToken(token, sessionSecret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authError = await validateAdminSession(req);
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

    // Generate embeddings for any models that now have a description but no vector yet.
    // Uses OPENROUTER_API_KEY (already required above) to call openai/text-embedding-3-small via OpenRouter.
    if (result.success) {
      const embeddingsGenerated = await generatePendingEmbeddings(apiKey);
      logger.info('Embeddings generated', { embeddingsGenerated });
      return NextResponse.json({ ...result, embeddingsGenerated });
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
