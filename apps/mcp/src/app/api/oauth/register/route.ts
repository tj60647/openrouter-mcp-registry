/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * Interactive MCP clients (Claude Code, Cursor, VS Code…) self-register here as
 * part of the authorization-code + PKCE flow, then use /api/oauth/authorize.
 * Registration is enabled by default because the MCP client bootstrap depends on
 * it; set OAUTH_DISABLE_REGISTRATION=true to turn it off (e.g. if you provision
 * clients manually). Registrations are persisted in Postgres.
 *
 * Clients registering redirect_uris are treated as public (PKCE, no secret),
 * which is what interactive MCP clients expect. A client that registers no
 * redirect_uris is issued a confidential secret for the client_credentials grant.
 *
 * Rate limited: 5 registrations per 15 minutes per IP.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssuerUrl } from '../../../../lib/oauth';
import { createDynamicClient } from '../../../../lib/oauthStore';
import { checkRateLimit } from '../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 5 registrations per 15 minutes per IP — prevents registration flooding.
const REGISTER_RATE_LIMIT = { limit: 5, windowMs: 15 * 60_000 };

function isHttpsOrLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    // Allow loopback for native/CLI clients (Claude Code, Cursor) per OAuth 2.1.
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) {
      return true;
    }
    // Custom app schemes (e.g. cursor://) are permitted for native clients.
    return u.protocol !== 'http:';
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env['OAUTH_DISABLE_REGISTRATION'] === 'true') {
    return NextResponse.json({ error: 'registration_not_supported' }, { status: 400 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`oauth:register:${ip}`, REGISTER_RATE_LIMIT)) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    client_name?: unknown;
    scope?: unknown;
    redirect_uris?: unknown;
  };

  const clientName =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim()
      : 'Anonymous client';
  const requestedScope =
    typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim() : 'mcp:read';

  // Validate redirect_uris (RFC 7591): must be an array of strings if present.
  let redirectUris: string[] = [];
  if (body.redirect_uris !== undefined) {
    if (
      !Array.isArray(body.redirect_uris) ||
      !body.redirect_uris.every((u) => typeof u === 'string')
    ) {
      return NextResponse.json(
        { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be an array of strings' },
        { status: 400 },
      );
    }
    redirectUris = body.redirect_uris as string[];
    const bad = redirectUris.find((u) => !isHttpsOrLoopback(u));
    if (bad) {
      return NextResponse.json(
        { error: 'invalid_redirect_uri', error_description: `redirect_uri not allowed: ${bad}` },
        { status: 400 },
      );
    }
  }

  // A client with redirect_uris is an interactive public client (PKCE, no secret).
  const isPublic = redirectUris.length > 0;

  const reg = await createDynamicClient({
    clientName,
    requestedScope,
    redirectUris,
    isPublic,
  });
  const issuer = getIssuerUrl();

  const response: Record<string, unknown> = {
    client_id: reg.clientId,
    client_name: reg.clientName,
    redirect_uris: reg.redirectUris,
    grant_types: reg.grantTypes,
    scope: reg.scope,
    token_endpoint_auth_method: reg.tokenEndpointAuthMethod,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
  };
  if (reg.clientSecret) {
    response['client_secret'] = reg.clientSecret;
  }

  return NextResponse.json(response, { status: 201 });
}
