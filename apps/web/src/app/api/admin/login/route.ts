import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPassword } from '../../../../lib/adminAuth';
import { getActiveAdminByUsername } from '../../../../lib/admins';
import { createSessionToken, SESSION_COOKIE } from '../../../../lib/session';
import { checkRateLimit } from '../../../../lib/rateLimit';

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
    const postgresUrl = process.env['POSTGRES_URL'];

    if (!sessionSecret || !postgresUrl) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 503 });
    }

    const admin = await getActiveAdminByUsername(username);
    if (!admin || !(await verifyAdminPassword(password, admin.passwordHash))) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }

    const token = await createSessionToken(sessionSecret);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60, // 1 hour
    });
    return res;
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
