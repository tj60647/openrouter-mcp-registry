import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE } from '../../../../lib/session';
import { buildMcpHeaders, getConfiguredMcpUrl } from '../../../../lib/mcpProxy';

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
    const body: unknown = await req.json().catch(() => ({}));
    const mcpUrl = getConfiguredMcpUrl();
    if (!mcpUrl) {
      return NextResponse.json({ error: 'MCP_URL is not configured' }, { status: 503 });
    }
    const authHeaders = await buildMcpHeaders(mcpUrl, 'admin:write');
    const res = await fetch(`${mcpUrl}/api/admin/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
