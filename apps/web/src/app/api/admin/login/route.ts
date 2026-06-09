import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, SESSION_COOKIE } from '../../../../lib/session';
import { checkRateLimit } from '../../../../lib/rateLimit';
import { getConfiguredMcpUrl } from '../../../../lib/mcpProxy';

export const runtime = 'nodejs';

const LOGIN_RATE_LIMIT = { limit: 5, windowMs: 15 * 60_000 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`login:${ip}`, LOGIN_RATE_LIMIT)) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again later.' },
      { status: 429 }
    );
  }

  const sessionSecret = process.env['ADMIN_SESSION_SECRET'];
  const mcpUrl = getConfiguredMcpUrl();
  if (!sessionSecret || !mcpUrl) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 503 });
  }

  try {
    const rawBody = await req.text();
    const loginRes = await fetch(`${mcpUrl}/api/admin/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ip ? { 'x-forwarded-for': ip } : {}),
      },
      body: rawBody,
    });

    if (!loginRes.ok) {
      const data = (await loginRes.json().catch(() => ({}))) as { error?: string };
      return NextResponse.json(
        { error: data.error ?? 'Invalid username or password' },
        { status: loginRes.status }
      );
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
    return NextResponse.json({ error: 'Admin auth backend unavailable' }, { status: 503 });
  }
}
