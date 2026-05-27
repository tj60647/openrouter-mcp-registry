/**
 * OAuth 2.0 Token Endpoint — Client Credentials grant (RFC 6749 §4.4).
 *
 * Accepts credentials via:
 *   - HTTP Basic auth (client_secret_basic): Authorization: Basic base64(id:secret)
 *   - POST body (client_secret_post): application/x-www-form-urlencoded or application/json
 *
 * Returns a short-lived HS256 JWT access token.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  signAccessToken,
  getClient,
  verifyClientSecret,
  TOKEN_TTL_SECONDS,
} from '../../../../lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let grantType: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scope: string | undefined;

  // HTTP Basic auth takes precedence (client_secret_basic)
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx > 0) {
      clientId = decodeURIComponent(decoded.slice(0, colonIdx));
      clientSecret = decodeURIComponent(decoded.slice(colonIdx + 1));
    }
  }

  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await req.text();
    const params = new URLSearchParams(text);
    grantType = params.get('grant_type') ?? undefined;
    clientId ??= params.get('client_id') ?? undefined;
    clientSecret ??= params.get('client_secret') ?? undefined;
    scope = params.get('scope') ?? undefined;
  } else {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    grantType = body['grant_type'];
    clientId ??= body['client_id'];
    clientSecret ??= body['client_secret'];
    scope = body['scope'];
  }

  if (grantType !== 'client_credentials') {
    return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const client = getClient(clientId);
  if (!client || !verifyClientSecret(clientSecret, client.clientSecretHash)) {
    return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
  }

  // Grant the intersection of requested and allowed scopes; fall back to client's scope.
  const allowedScopes = new Set(client.scope.split(' '));
  const requestedScopes = scope ? scope.split(' ').filter((s) => allowedScopes.has(s)) : [];
  const grantedScope = requestedScopes.length > 0 ? requestedScopes.join(' ') : client.scope;

  try {
    const token = await signAccessToken(clientId, grantedScope);
    return NextResponse.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: grantedScope,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json(
      { error: 'server_error', error_description: message },
      { status: 500 }
    );
  }
}
