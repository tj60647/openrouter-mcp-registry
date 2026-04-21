import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

// Per-process nonce used to HMAC both sides of every token comparison.
// Hashing to a fixed-length digest means timingSafeEqual receives equal-length
// buffers regardless of the actual token lengths, preventing length-based
// timing side-channels without truncating or padding the tokens themselves.
const _HMAC_NONCE = randomBytes(32);

function safeEqual(a: string, b: string): boolean {
  const aHash = createHmac('sha256', _HMAC_NONCE).update(a).digest();
  const bHash = createHmac('sha256', _HMAC_NONCE).update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

export function validateAdminToken(req: NextRequest): NextResponse | null {
  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim();
  const expected = process.env['ADMIN_SECRET'];
  if (!expected) {
    return NextResponse.json({ error: 'Admin auth not configured' }, { status: 503 });
  }
  if (!token || !safeEqual(token, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export function validateMcpToken(req: NextRequest): NextResponse | null {
  const mcpKey = process.env['MCP_API_KEY'];
  if (!mcpKey) return null; // open if not configured

  const token = req.headers.get('authorization')?.replace('Bearer ', '').trim();
  if (!token || !safeEqual(token, mcpKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
