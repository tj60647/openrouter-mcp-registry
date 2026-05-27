import { NextResponse } from 'next/server';
import { getIssuerUrl } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * Required by the MCP specification for OAuth-enabled servers.
 *
 * The registration_endpoint is only advertised when OAUTH_ENABLE_REGISTRATION=true,
 * so that clients do not attempt self-registration on servers that don't support it.
 */
export async function GET(): Promise<NextResponse> {
  const issuer = getIssuerUrl();
  const registrationEnabled = process.env['OAUTH_ENABLE_REGISTRATION'] === 'true';

  const metadata: Record<string, unknown> = {
    issuer,
    token_endpoint: `${issuer}/api/oauth/token`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp:read'],
    response_types_supported: ['token'],
  };

  if (registrationEnabled) {
    metadata['registration_endpoint'] = `${issuer}/api/oauth/register`;
  }

  return NextResponse.json(metadata);
}
