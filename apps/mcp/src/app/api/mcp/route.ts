import { verifyAccessToken } from '../../../lib/oauth';
import { initMcpServer } from '../../../lib/mcp-server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * Verify an incoming Bearer token against our self-hosted OAuth AS.
 *
 * Open mode: when OAUTH_JWT_SECRET is not configured, every connection is
 * accepted with anonymous identity (matches the old MCP_API_KEY=unset behaviour).
 */
const verifyToken = async (
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  const jwtSecret = process.env['OAUTH_JWT_SECRET'];
  if (!jwtSecret) {
    // Open mode — no auth configured.
    return { token: bearerToken ?? '', clientId: 'anonymous', scopes: ['mcp:read'] };
  }
  if (!bearerToken) return undefined;
  try {
    const claims = await verifyAccessToken(bearerToken);
    return {
      token: bearerToken,
      clientId: claims.sub ?? 'unknown',
      scopes: (claims.scope ?? 'mcp:read').split(' ').filter(Boolean),
    };
  } catch {
    return undefined;
  }
};

const handler = createMcpHandler(
  initMcpServer,
  { serverInfo: { name: 'openrouter-mcp-registry', version: '1.0.0' } },
  { basePath: '/api', maxDuration: 60 },
);

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ['mcp:read'],
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
