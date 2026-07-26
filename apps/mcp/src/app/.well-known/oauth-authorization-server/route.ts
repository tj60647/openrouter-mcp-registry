import { NextResponse } from 'next/server';
import { getIssuerUrl, SUPPORTED_GRANT_TYPES } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * Required by the MCP specification for OAuth-enabled servers.
 *
 * Advertises the authorization-code + PKCE flow (for interactive MCP clients),
 * refresh_token, and client_credentials (for trusted service clients).
 * Dynamic client registration is advertised unless explicitly disabled.
 */
export async function GET(): Promise<NextResponse> {
  const issuer = getIssuerUrl();
  const registrationDisabled = process.env['OAUTH_DISABLE_REGISTRATION'] === 'true';

  const metadata: Record<string, unknown> = {
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    // Shared with the registration/token endpoints so what is advertised is
    // exactly what is accepted.
    grant_types_supported: [...SUPPORTED_GRANT_TYPES],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    scopes_supported: ['mcp:read'],
  };

  if (!registrationDisabled) {
    metadata['registration_endpoint'] = `${issuer}/api/oauth/register`;
  }

  return NextResponse.json(metadata);
}
