/**
 * OAuth 2.1 Token Endpoint.
 *
 * Supported grants:
 *   - authorization_code (+ PKCE): interactive MCP clients (Claude Code, Cursor…)
 *   - refresh_token: silent re-issue of access tokens for interactive clients
 *   - client_credentials: trusted service clients (e.g. apps/web server routes)
 *
 * Credentials (for confidential clients) accepted via:
 *   - HTTP Basic auth (client_secret_basic): Authorization: Basic base64(id:secret)
 *   - POST body (client_secret_post): application/x-www-form-urlencoded or application/json
 *
 * Returns short-lived HS256 JWT access tokens (+ refresh tokens for the
 * authorization_code / refresh_token grants).
 *
 * Rate limited: 20 requests per minute per IP.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  verifyClientSecret,
  verifyPkceS256,
  filterScopes,
  TOKEN_TTL_SECONDS,
} from '../../../../lib/oauth';
import { findClient, consumeAuthorizationCode } from '../../../../lib/oauthStore';
import { checkRateLimit } from '../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 20 token requests per minute per IP — limits credential-stuffing attacks.
const TOKEN_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

function tokenError(error: string, status: number, description?: string): NextResponse {
  const body: Record<string, string> = { error };
  if (description) body['error_description'] = description;
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`oauth:token:${ip}`, TOKEN_RATE_LIMIT)) {
    return tokenError('too_many_requests', 429);
  }

  let clientId: string | undefined;
  let clientSecret: string | undefined;

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

  // Parse the body (form-encoded or JSON) into a flat param map.
  const params: Record<string, string | undefined> = {};
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const search = new URLSearchParams(await req.text());
    for (const [k, v] of search) params[k] = v;
  } else {
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    Object.assign(params, body);
  }

  clientId ??= params['client_id'];
  clientSecret ??= params['client_secret'];
  const grantType = params['grant_type'];

  if (!clientId) return tokenError('invalid_request', 400, 'client_id is required');

  const client = await findClient(clientId);
  if (!client) return tokenError('invalid_client', 401);

  // Confidential clients must present a valid secret. Public (PKCE) clients have
  // token_endpoint_auth_method 'none' and no stored secret hash.
  if (client.clientSecretHash) {
    if (!clientSecret || !verifyClientSecret(clientSecret, client.clientSecretHash)) {
      return tokenError('invalid_client', 401);
    }
  }

  switch (grantType) {
    case 'authorization_code':
      return handleAuthorizationCode(client.clientId, params);
    case 'refresh_token':
      return handleRefreshToken(client.clientId, params);
    case 'client_credentials':
      return handleClientCredentials(client.clientId, client.scope, params['scope']);
    default:
      return tokenError('unsupported_grant_type', 400);
  }
}

async function handleAuthorizationCode(
  clientId: string,
  params: Record<string, string | undefined>,
): Promise<NextResponse> {
  const code = params['code'];
  const redirectUri = params['redirect_uri'];
  const codeVerifier = params['code_verifier'];

  if (!code || !redirectUri || !codeVerifier) {
    return tokenError('invalid_request', 400, 'code, redirect_uri and code_verifier are required');
  }

  const record = await consumeAuthorizationCode(code);
  if (!record) return tokenError('invalid_grant', 400, 'authorization code not found');
  if (record.expired) return tokenError('invalid_grant', 400, 'authorization code expired');
  if (record.clientId !== clientId) return tokenError('invalid_grant', 400, 'client mismatch');
  if (record.redirectUri !== redirectUri) {
    return tokenError('invalid_grant', 400, 'redirect_uri mismatch');
  }
  if (!verifyPkceS256(codeVerifier, record.codeChallenge)) {
    return tokenError('invalid_grant', 400, 'PKCE verification failed');
  }

  return issueTokens(clientId, record.scope, true);
}

async function handleRefreshToken(
  clientId: string,
  params: Record<string, string | undefined>,
): Promise<NextResponse> {
  const refreshToken = params['refresh_token'];
  if (!refreshToken) return tokenError('invalid_request', 400, 'refresh_token is required');

  let claims;
  try {
    claims = await verifyRefreshToken(refreshToken);
  } catch {
    return tokenError('invalid_grant', 400, 'invalid or expired refresh token');
  }
  if (claims.sub !== clientId) return tokenError('invalid_grant', 400, 'client mismatch');

  // Honour a narrowing scope request; otherwise keep the token's scope.
  const requested = params['scope'];
  const scope = requested
    ? filterScopes(
        requested
          .split(' ')
          .filter((s) => (claims.scope ?? '').split(' ').includes(s))
          .join(' '),
      )
    : filterScopes(claims.scope);

  return issueTokens(clientId, scope, true);
}

async function handleClientCredentials(
  clientId: string,
  clientScope: string,
  requestedScope: string | undefined,
): Promise<NextResponse> {
  // Grant the intersection of requested and the client's allowed scopes.
  const allowed = new Set(clientScope.split(' '));
  const requested = requestedScope ? requestedScope.split(' ').filter((s) => allowed.has(s)) : [];
  const scope = requested.length > 0 ? requested.join(' ') : clientScope;
  return issueTokens(clientId, scope, false);
}

async function issueTokens(
  clientId: string,
  scope: string,
  withRefresh: boolean,
): Promise<NextResponse> {
  try {
    const accessToken = await signAccessToken(clientId, scope);
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope,
    };
    if (withRefresh) {
      body['refresh_token'] = await signRefreshToken(clientId, scope);
    }
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return tokenError('server_error', 500, message);
  }
}
