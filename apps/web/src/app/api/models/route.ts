import { NextRequest, NextResponse } from 'next/server';
import { PaginationSchema } from '@openrouter-mcp/shared';
import { getModels, getModelsCount } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const parsed = PaginationSchema.safeParse(sp);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { limit, offset, provider, query, sortBy, toolsOnly, reasoningOnly } = parsed.data;
    const models = await getModels({ limit, offset, provider, query, sortBy, toolsOnly, reasoningOnly });
    const count = await getModelsCount({ provider, query, toolsOnly, reasoningOnly });
    return NextResponse.json({ models, count, limit, offset });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
