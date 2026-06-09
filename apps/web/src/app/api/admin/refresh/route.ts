import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE } from '../../../../lib/session';
import { getMcpBaseUrl } from '../../../../lib/mcpAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const sessionSecret = process.env['ADMIN_SESSION_SECRET'];
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!sessionSecret || !token || !(await verifySessionToken(token, sessionSecret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const mcpUrl = getMcpBaseUrl();
  const adminSecret = process.env['ADMIN_SECRET'];

  if (!mcpUrl || !adminSecret) {
    return NextResponse.json({ error: 'MCP or admin auth not configured' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const mcpRes = await fetch(`${mcpUrl}/api/admin/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminSecret}`,
    },
    body: JSON.stringify(body),
  });

  const json = await mcpRes.json() as Record<string, unknown>;
  return NextResponse.json(json, { status: mcpRes.status });
}
