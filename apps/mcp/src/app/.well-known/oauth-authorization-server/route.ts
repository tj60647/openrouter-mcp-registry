import { NextResponse } from 'next/server';
import { getIssuerUrl } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * Required by the MCP specification for OAuth-enabled servers.
 */
export async function GET(): Promise<NextResponse> {
  const issuer = getIssuerUrl();

  return NextResponse.json({
    issuer,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp:read'],
    response_types_supported: ['token'],
  });
}
