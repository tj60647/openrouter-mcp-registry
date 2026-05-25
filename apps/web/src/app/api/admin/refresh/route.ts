import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE } from '../../../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const mcpBase = () =>
  (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');

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
    const adminSecret = process.env['ADMIN_SECRET'];
    if (!adminSecret) {
      return NextResponse.json({ error: 'ADMIN_SECRET not configured' }, { status: 503 });
    }
    const res = await fetch(`${mcpBase()}/api/admin/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSecret}`,
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


