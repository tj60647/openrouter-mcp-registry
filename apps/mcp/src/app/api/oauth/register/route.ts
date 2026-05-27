/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591 — simplified subset).
 *
 * Disabled by default. Set OAUTH_ENABLE_REGISTRATION=true to allow clients
 * to self-register. In production, leave this unset unless you explicitly
 * want open registration.
 *
 * Registered clients are stored in-process; they do not survive restarts.
 * For persistent multi-instance deployments, replace the in-memory store
 * in lib/oauth.ts with a DB-backed implementation.
 *
 * Rate limited: 5 registrations per 15 minutes per IP.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssuerUrl, registerDynamicClient } from '../../../../lib/oauth';
import { checkRateLimit } from '../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 5 registrations per 15 minutes per IP — prevents credential harvesting.
const REGISTER_RATE_LIMIT = { limit: 5, windowMs: 15 * 60_000 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env['OAUTH_ENABLE_REGISTRATION'] !== 'true') {
    return NextResponse.json({ error: 'registration_not_supported' }, { status: 400 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`oauth:register:${ip}`, REGISTER_RATE_LIMIT)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    client_name?: unknown;
    scope?: unknown;
  };

  const clientName =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim()
      : 'Anonymous client';
  const requestedScope =
    typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : 'mcp:read';

  const { clientId, clientSecret, scope: grantedScope } = registerDynamicClient(clientName, requestedScope);
  const issuer = getIssuerUrl();

  return NextResponse.json(
    {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      scope: grantedScope,
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['client_credentials'],
      token_endpoint: `${issuer}/api/oauth/token`,
    },
    { status: 201 }
  );
}
