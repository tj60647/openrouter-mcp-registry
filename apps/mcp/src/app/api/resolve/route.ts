import { NextRequest, NextResponse } from 'next/server';
import {
  ResolveInputSchema,
  ModelRegistry,
  InMemoryAliasService,
  SYSTEM_ALIASES,
} from '@openrouter-mcp/shared';
import { getModelById, resolveAlias } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const parsed = ResolveInputSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { input } = parsed.data;

    // Build a registry that checks DB aliases first, then system aliases
    const dbAlias = await resolveAlias(input);
    const dbAliases = dbAlias ? { [input]: dbAlias } : {};
    const combinedAliases = { ...SYSTEM_ALIASES, ...dbAliases };

    const aliasService = new InMemoryAliasService(combinedAliases);
    const registry = new ModelRegistry(
      { findById: getModelById },
      aliasService
    );

    const result = await registry.resolve(input);
    return NextResponse.json({
      input,
      resolved: result.resolved,
      source: result.source,
      found: result.model !== null,
      model: result.model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
