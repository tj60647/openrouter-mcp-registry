import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession, mcpAdminFetch } from '../../../../lib/requireAdminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin panel proxy: list registered OAuth clients (gated by admin session). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAdminSession(req);
  if (error) return error;

  const mcpRes = await mcpAdminFetch('/api/admin/clients');
  if (!mcpRes) {
    return NextResponse.json({ error: 'MCP or admin auth not configured' }, { status: 503 });
  }
  const json = (await mcpRes.json()) as Record<string, unknown>;
  return NextResponse.json(json, { status: mcpRes.status });
}
