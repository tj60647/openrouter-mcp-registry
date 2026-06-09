import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '../../../../lib/oauth';
import { verifyAdminPassword } from '../../../../lib/adminAuth';
import { getActiveAdminByUsername } from '../../../../lib/admins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireMcpServerAuth(req: NextRequest): Promise<NextResponse | null> {
  const jwtSecret = process.env['OAUTH_JWT_SECRET'];
  if (!jwtSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      return NextResponse.json({ error: 'MCP auth is not configured' }, { status: 503 });
    }
    return null;
  }

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const claims = await verifyAccessToken(token);
    const scopes = (claims.scope ?? '').split(' ').filter(Boolean);
    if (!scopes.includes('mcp:read')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return null;
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authError = await requireMcpServerAuth(req);
  if (authError) return authError;

  try {
    const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const admin = await getActiveAdminByUsername(username);
    const valid = !!admin && (await verifyAdminPassword(password, admin.passwordHash));

    if (!valid) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
