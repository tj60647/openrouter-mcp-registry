/**
 * OAuth 2.0 Dynamic Client Registration Management (RFC 7592).
 *
 * Lets a client that registered via POST /api/oauth/register read or delete its
 * own registration, so an abandoned or mis-registered client can be cleaned up
 * without operator involvement.
 *
 * Both verbs authenticate with the `registration_access_token` returned once at
 * registration time (`Authorization: Bearer <token>`), compared in constant time
 * against the SHA-256 hash stored for that client_id. Anything else — unknown
 * client, already-deleted client, missing or wrong token — is a flat
 * 401 invalid_token so the endpoint cannot be used to enumerate client ids.
 *
 * Rate limited: 30 requests per 15 minutes per IP.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssuerUrl, verifyClientSecret } from '../../../../../lib/oauth';
import {
  findClientRegistration,
  revokeClient,
  type ClientRegistration,
} from '../../../../../lib/oauthStore';
import { checkRateLimit } from '../../../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 30 management requests per 15 minutes per IP.
const MANAGE_RATE_LIMIT = { limit: 30, windowMs: 15 * 60_000 };

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: 'invalid_token' },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } },
  );
}

/**
 * Rate-limit, then resolve the client this request is authorized to manage.
 * Returns the registration on success or the response to send on failure.
 */
async function authorizeRequest(
  req: NextRequest,
  clientId: string,
): Promise<ClientRegistration | NextResponse> {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!(await checkRateLimit(`oauth:register-manage:${ip}`, MANAGE_RATE_LIMIT))) {
    return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  }

  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return unauthorized();
  const token = header.slice(7).trim();
  if (!token) return unauthorized();

  const registration = await findClientRegistration(clientId);
  // Clients registered before RFC 7592 support have no management token and so
  // can never be managed here; the admin revoke endpoint still covers them.
  if (!registration?.registrationAccessTokenHash) return unauthorized();

  // verifyClientSecret is the shared timing-safe "plaintext vs SHA-256" check.
  if (!verifyClientSecret(token, registration.registrationAccessTokenHash)) return unauthorized();

  return registration;
}

/** Read the client's currently-registered metadata. Never includes a secret. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ client_id: string }> },
): Promise<NextResponse> {
  const { client_id } = await params;
  const clientId = decodeURIComponent(client_id);

  const result = await authorizeRequest(req, clientId);
  if (result instanceof NextResponse) return result;

  const issuer = getIssuerUrl();
  return NextResponse.json({
    client_id: result.clientId,
    client_id_issued_at: result.clientIdIssuedAt,
    client_name: result.clientName,
    redirect_uris: result.redirectUris,
    grant_types: result.grantTypes,
    scope: result.scope,
    token_endpoint_auth_method: result.tokenEndpointAuthMethod,
    registration_client_uri: `${issuer}/api/oauth/register/${result.clientId}`,
  });
}

/** Delete (revoke) the client. It can no longer authorize or obtain tokens. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ client_id: string }> },
): Promise<NextResponse> {
  const { client_id } = await params;
  const clientId = decodeURIComponent(client_id);

  const result = await authorizeRequest(req, clientId);
  if (result instanceof NextResponse) return result;

  await revokeClient(clientId);
  return new NextResponse(null, { status: 204 });
}
