import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, SESSION_COOKIE } from '../../../../lib/session';

export const runtime = 'nodejs';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';

    const adminSecret = process.env['ADMIN_SECRET'];
    const sessionSecret = process.env['ADMIN_SESSION_SECRET'];

    if (!adminSecret || !sessionSecret) {
      return NextResponse.json({ error: 'Auth not configured' }, { status: 503 });
    }

    const provided = Buffer.from(password);
    const expected = Buffer.from(adminSecret);
    const match =
      provided.length === expected.length && timingSafeEqual(provided, expected);

    if (!match) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
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
