/** Server-side helpers for talking from apps/web route handlers to apps/mcp. */

export function getMcpBaseUrl(): string | undefined {
  return (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'])?.replace(/\/+$/, '');
}

/**
 * Cached service token, reused until shortly before it expires.
 *
 * Every one of these calls is a request to apps/mcp's token endpoint, which is
 * rate limited per source address — and every request apps/web makes arrives
 * from the same egress address. Minting a fresh token per request was merely
 * wasteful while that limit was a per-lambda in-memory counter; now that it is
 * a shared Postgres counter the limit actually binds, and the first traffic it
 * would throttle is apps/web's own.
 *
 * Per-instance by design: a warm lambda reuses its token, a cold one mints a
 * new one. That is enough to turn per-request minting into roughly per-hour.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;
/** Renew this long before expiry so an in-flight request never carries a dead token. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Drop the cached service token. Exposed for tests. */
export function resetMcpTokenCache(): void {
  cachedToken = null;
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

  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
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

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  const token = data.access_token ?? null;

  if (token) {
    // Trust the server's expires_in, but never cache longer than an hour and
    // never past the refresh margin, so a short-lived token is not held stale.
    const ttlMs = Math.min((data.expires_in ?? 3600) * 1000, 3600_000);
    const lifetime = ttlMs - TOKEN_REFRESH_MARGIN_MS;
    if (lifetime > 0) cachedToken = { value: token, expiresAt: Date.now() + lifetime };
  }

  return token;
}

export async function getMcpAuthHeaders(mcpUrl: string): Promise<Record<string, string>> {
  const bearerToken = await getMcpBearerToken(mcpUrl);
  return bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}
