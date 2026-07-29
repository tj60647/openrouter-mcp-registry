/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * Interactive MCP clients (Claude Code, Cursor, VS Code…) self-register here as
 * part of the authorization-code + PKCE flow, then use /api/oauth/authorize.
 * Registrations are persisted in Postgres.
 *
 * OPEN BY DEFAULT — THIS IS A DECISION, NOT AN OVERSIGHT. The registry serves
 * public, read-only catalogue data, and the MCP client bootstrap depends on
 * self-registration: requiring manual provisioning would mean no Claude Code or
 * Cursor user could connect without an operator in the loop. The exposure a
 * self-registered client gets is bounded deliberately:
 *
 *   - the only grantable scope is mcp:read (ALLOWED_SCOPES in lib/oauth.ts),
 *     and every requested scope is coerced to it;
 *   - every tool is read-only against the registry;
 *   - the one tool that spends money, semantic_search, has a per-client
 *     per-minute budget, as does the tool path as a whole (lib/mcp-server.ts);
 *   - registration itself is limited to 5 per 15 minutes per IP, durably.
 *
 * Two levers exist for operators who want it closed: set
 * OAUTH_REGISTRATION_ACCESS_TOKEN to require an initial access token on this
 * endpoint, or OAUTH_DISABLE_REGISTRATION=true to disable it entirely. Neither
 * is the default, on purpose. Revisit that only if the scope set stops being
 * read-only.
 *
 * `grant_types` is honoured (RFC 7591 §3.2.1) and echoed back. When omitted it
 * defaults to authorization_code + refresh_token for clients that register
 * redirect_uris, and client_credentials for clients that do not. Only a
 * client_credentials client is confidential (issued a secret); clients with
 * redirect_uris are public (PKCE, no secret) and may not use client_credentials.
 *
 * Set OAUTH_REGISTRATION_ACCESS_TOKEN to require an initial access token
 * (`Authorization: Bearer <token>`) on this endpoint. Unset, registration is open.
 *
 * The response carries an RFC 7592 `registration_access_token` and
 * `registration_client_uri` so a client can read or delete its own registration.
 *
 * Rate limited: 5 registrations per 15 minutes per IP.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getIssuerUrl,
  constantTimeEquals,
  InvalidClientMetadataError,
} from '../../../../lib/oauth';
import { createDynamicClient, type DynamicClientRegistration } from '../../../../lib/oauthStore';
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

function invalidMetadata(description: string): NextResponse {
  return NextResponse.json(
    { error: 'invalid_client_metadata', error_description: description },
    { status: 400 },
  );
}

/**
 * Enforce the optional initial access token. Returns a 401 response when
 * OAUTH_REGISTRATION_ACCESS_TOKEN is configured and the request does not
 * present it; null when the request may proceed.
 */
function checkInitialAccessToken(req: NextRequest): NextResponse | null {
  const expected = process.env['OAUTH_REGISTRATION_ACCESS_TOKEN'];
  if (!expected) return null;

  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !constantTimeEquals(provided, expected)) {
    return NextResponse.json(
      { error: 'invalid_token' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } },
    );
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env['OAUTH_DISABLE_REGISTRATION'] === 'true') {
    return NextResponse.json({ error: 'registration_not_supported' }, { status: 400 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!(await checkRateLimit(`oauth:register:${ip}`, REGISTER_RATE_LIMIT))) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  // Checked after the rate limit so the token itself cannot be brute-forced.
  const tokenError = checkInitialAccessToken(req);
  if (tokenError) return tokenError;

  const body = (await req.json().catch(() => ({}))) as {
    client_name?: unknown;
    scope?: unknown;
    redirect_uris?: unknown;
    grant_types?: unknown;
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

  // Validate grant_types shape here; the allowed combinations are resolved by
  // createDynamicClient so the rules cannot be bypassed by another caller.
  let requestedGrantTypes: string[] | undefined;
  if (body.grant_types !== undefined) {
    if (!Array.isArray(body.grant_types) || !body.grant_types.every((g) => typeof g === 'string')) {
      return invalidMetadata('grant_types must be an array of strings');
    }
    requestedGrantTypes = body.grant_types as string[];
  }

  let reg: DynamicClientRegistration;
  try {
    reg = await createDynamicClient({
      clientName,
      requestedScope,
      redirectUris,
      requestedGrantTypes,
    });
  } catch (err) {
    if (err instanceof InvalidClientMetadataError) return invalidMetadata(err.message);
    throw err;
  }
  const issuer = getIssuerUrl();

  const response: Record<string, unknown> = {
    client_id: reg.clientId,
    client_id_issued_at: reg.clientIdIssuedAt,
    client_name: reg.clientName,
    redirect_uris: reg.redirectUris,
    grant_types: reg.grantTypes,
    scope: reg.scope,
    token_endpoint_auth_method: reg.tokenEndpointAuthMethod,
    registration_access_token: reg.registrationAccessToken,
    registration_client_uri: `${issuer}/api/oauth/register/${reg.clientId}`,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
  };
  if (reg.clientSecret) {
    response['client_secret'] = reg.clientSecret;
    // 0 = never expires (RFC 7591 §3.2.1).
    response['client_secret_expires_at'] = 0;
  }

  return NextResponse.json(response, { status: 201 });
}
