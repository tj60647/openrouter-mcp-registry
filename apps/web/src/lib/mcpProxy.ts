export function getConfiguredMcpUrl(): string | undefined {
  return (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'])?.replace(/\/+$/, '');
}

export async function getMcpBearerToken(
  mcpUrl: string,
  scope = 'mcp:read'
): Promise<string | null> {
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

  const tokenUrl = `${mcpUrl}/api/oauth/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
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

export async function buildMcpHeaders(mcpUrl: string, scope = 'mcp:read'): Promise<HeadersInit> {
  const token = await getMcpBearerToken(mcpUrl, scope);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
