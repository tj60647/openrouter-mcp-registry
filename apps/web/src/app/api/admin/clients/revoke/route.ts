import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession, mcpAdminFetch } from '../../../../../lib/requireAdminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin panel proxy: revoke or restore an OAuth client (gated by admin session). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAdminSession(req);
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const mcpRes = await mcpAdminFetch('/api/admin/clients/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!mcpRes) {
    return NextResponse.json({ error: 'MCP or admin auth not configured' }, { status: 503 });
  }
  const json = (await mcpRes.json()) as Record<string, unknown>;
  return NextResponse.json(json, { status: mcpRes.status });
}
