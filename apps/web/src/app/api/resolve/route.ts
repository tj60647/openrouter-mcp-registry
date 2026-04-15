import { NextRequest, NextResponse } from 'next/server';
import {
  ResolveInputSchema,
  ModelRegistry,
  InMemoryAliasService,
  SYSTEM_ALIASES,
} from '@openrouter-mcp/shared';
import { sql } from '@vercel/postgres';
import type { ModelRow } from '@openrouter-mcp/shared';
import { rowToModel } from '@openrouter-mcp/shared';

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

    async function findById(id: string) {
      const result = await sql<ModelRow>`SELECT * FROM models WHERE id = ${id} LIMIT 1`;
      return result.rows[0] ? rowToModel(result.rows[0]) : null;
    }

    async function resolveDbAlias(alias: string): Promise<string | null> {
      const result = await sql<{ model_id: string }>`
        SELECT model_id FROM aliases WHERE alias = ${alias} LIMIT 1
      `;
      return result.rows[0]?.model_id ?? null;
    }

    const dbAlias = await resolveDbAlias(input);
    const dbAliases = dbAlias ? { [input]: dbAlias } : {};
    const combinedAliases = { ...SYSTEM_ALIASES, ...dbAliases };

    const aliasService = new InMemoryAliasService(combinedAliases);
    const registry = new ModelRegistry({ findById }, aliasService);
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
