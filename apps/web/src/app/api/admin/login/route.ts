import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, SESSION_COOKIE } from '../../../../lib/session';
import { checkRateLimit } from '../../../../lib/rateLimit';
import { getMcpAuthHeaders, getMcpBaseUrl } from '../../../../lib/mcpAuth';

export const runtime = 'nodejs';

// 5 login attempts per 15 minutes per IP — brute-force protection.
const LOGIN_RATE_LIMIT = { limit: 5, windowMs: 15 * 60_000 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`login:${ip}`, LOGIN_RATE_LIMIT)) {
    return NextResponse.json({ error: 'Too many login attempts. Try again later.' }, { status: 429 });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      username?: unknown;
      password?: unknown;
    };
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const sessionSecret = process.env['ADMIN_SESSION_SECRET'];
    const mcpUrl = getMcpBaseUrl();

    if (!sessionSecret || !mcpUrl) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 503 });
    }

    let authHeaders: Record<string, string>;
    try {
      authHeaders = await getMcpAuthHeaders(mcpUrl);
    } catch {
      return NextResponse.json({ error: 'MCP auth not configured' }, { status: 503 });
    }

    const verifyRes = await fetch(`${mcpUrl}/api/admin/verify-login`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (verifyRes.status === 401) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }
    if (!verifyRes.ok) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 503 });
    }

    const token = await createSessionToken(sessionSecret);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60,
    });
    return res;
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
