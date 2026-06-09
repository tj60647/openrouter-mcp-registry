import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPassword } from '../../../../lib/adminAuth';
import { getActiveAdminByUsername } from '../../../../lib/admins';
import { checkRateLimit } from '../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOGIN_RATE_LIMIT = { limit: 5, windowMs: 15 * 60_000 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`admin-login:${ip}`, LOGIN_RATE_LIMIT)) {
    return NextResponse.json(
      { error: 'Too many login attempts. Try again later.' },
      { status: 429 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    username?: unknown;
    password?: unknown;
  };
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';

  try {
    const admin = await getActiveAdminByUsername(username);
    if (!admin || !(await verifyAdminPassword(password, admin.passwordHash))) {
      return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Admin auth backend unavailable' }, { status: 503 });
  }
}
