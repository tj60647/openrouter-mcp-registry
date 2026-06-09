import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyAccessToken } from './oauth';

const _HMAC_NONCE = randomBytes(32);

function safeEqual(a: string, b: string): boolean {
  const aHash = createHmac('sha256', _HMAC_NONCE).update(a).digest();
  const bHash = createHmac('sha256', _HMAC_NONCE).update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

function getBearerToken(req: NextRequest): string | null {
  const auth = req.headers.get('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
}

async function hasAdminWriteScope(token: string): Promise<boolean> {
  if (!process.env['OAUTH_JWT_SECRET']) return false;
  try {
    const claims = await verifyAccessToken(token);
    return (claims.scope ?? '').split(' ').includes('admin:write');
  } catch {
    return false;
  }
}

export async function validateAdminToken(req: NextRequest): Promise<NextResponse | null> {
  const token = getBearerToken(req);
  const expected = process.env['ADMIN_SECRET'];
  if (token && expected && safeEqual(token, expected)) {
    return null;
  }
  if (token && (await hasAdminWriteScope(token))) {
    return null;
  }
  if (!expected && !process.env['OAUTH_JWT_SECRET']) {
    return NextResponse.json({ error: 'Admin auth not configured' }, { status: 503 });
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
