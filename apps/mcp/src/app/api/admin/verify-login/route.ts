import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from '../../../../lib/oauth';
import { verifyAdminPassword } from '../../../../lib/adminAuth';
import { getActiveAdminByUsername } from '../../../../lib/admins';
import { checkRateLimit, clearRateLimit } from '../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 10 password checks per 15 minutes, per username AND per source address.
 *
 * This is where the password comparison actually happens, and before this it
 * had no limit at all: anything holding an `mcp:read` token — which dynamic
 * registration hands out on request — could brute-force admin credentials here
 * unthrottled.
 *
 * The key includes the source address on purpose. Keying on the username alone
 * is the obvious choice, since every request forwarded by apps/web shares that
 * app's egress address, but it hands an attacker an account-lockout primitive:
 * ten deliberate failures against "admin" from anywhere would lock the real
 * administrator out of the panel for fifteen minutes, repeatedly, and the
 * counter lives in Postgres where they cannot clear it. Splitting by source
 * keeps an attacker's failures in the attacker's own bucket.
 *
 * The residual exposure is a distributed attack rotating addresses, which this
 * does not stop — but that is a far more expensive attack against a bcrypt
 * comparison than the lockout it replaces, and the same bound applies to every
 * other limiter in this app.
 */
const VERIFY_RATE_LIMIT = { limit: 10, windowMs: 15 * 60_000 };

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

    // Checked before the password comparison so the credential itself cannot be
    // brute-forced. Keyed on the normalized username so one account's attempts
    // cannot exhaust another's, and on the source address so one caller's
    // attempts cannot exhaust another caller's.
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const rateKey = `admin:verify-login:${username.trim().toLowerCase()}:${ip}`;
    if (!(await checkRateLimit(rateKey, VERIFY_RATE_LIMIT))) {
      return NextResponse.json({ ok: false, error: 'too_many_requests' }, { status: 429 });
    }

    const admin = await getActiveAdminByUsername(username);
    const valid = !!admin && (await verifyAdminPassword(password, admin.passwordHash));

    if (!valid) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    // A correct password clears the budget, so an administrator who mistypes a
    // few times and then succeeds does not stay near the limit for the rest of
    // the window.
    await clearRateLimit(rateKey);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
