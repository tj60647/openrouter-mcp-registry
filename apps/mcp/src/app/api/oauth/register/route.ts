/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591 — simplified subset).
 *
 * Can be disabled by setting OAUTH_DISABLE_REGISTRATION=true.
 * Registered clients are stored in-process; they do not survive restarts.
 * For persistent multi-instance deployments, replace the in-memory store
 * in lib/oauth.ts with a DB-backed implementation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssuerUrl, registerDynamicClient } from '../../../../lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env['OAUTH_DISABLE_REGISTRATION'] === 'true') {
    return NextResponse.json({ error: 'registration_not_supported' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    client_name?: unknown;
    scope?: unknown;
  };

  const clientName =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim()
      : 'Anonymous client';
  const scope = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : 'mcp:read';

  const { clientId, clientSecret } = registerDynamicClient(clientName, scope);
  const issuer = getIssuerUrl();

  return NextResponse.json(
    {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: clientName,
      scope,
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['client_credentials'],
      token_endpoint: `${issuer}/api/oauth/token`,
    },
    { status: 201 }
  );
}
