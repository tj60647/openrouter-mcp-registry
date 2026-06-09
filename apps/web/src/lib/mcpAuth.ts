/** Server-side helpers for talking from apps/web route handlers to apps/mcp. */

export function getMcpBaseUrl(): string | undefined {
  return (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'])?.replace(/\/+$/, '');
}

/**
 * Obtain a bearer token for the MCP server via OAuth client credentials.
 *
 * MCP_CLIENT_ID and MCP_CLIENT_SECRET are server-side only. Local development may
 * omit them when the MCP app is running without OAUTH_JWT_SECRET; production
 * fails closed so apps/web never silently attempts anonymous MCP access.
 */
export async function getMcpBearerToken(mcpUrl: string): Promise<string | null> {
  const clientId = process.env['MCP_CLIENT_ID'];
  const clientSecret = process.env['MCP_CLIENT_SECRET'];

  if (!clientId && !clientSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'MCP_CLIENT_ID and MCP_CLIENT_SECRET must be configured for production MCP access.'
      );
    }
    return null;
  }

  if (!clientId || !clientSecret) {
    throw new Error('Both MCP_CLIENT_ID and MCP_CLIENT_SECRET must be configured together.');
  }

  const res = await fetch(`${mcpUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'mcp:read',
    }),
  });

  if (!res.ok) {
    throw new Error(
      `MCP OAuth token request failed with status ${res.status}. Check MCP_CLIENT_ID/MCP_CLIENT_SECRET and OAUTH_JWT_SECRET.`
    );
  }

  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

export async function getMcpAuthHeaders(mcpUrl: string): Promise<Record<string, string>> {
  const bearerToken = await getMcpBearerToken(mcpUrl);
  return bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}
