import { callerFromToken } from '../../../lib/caller';
import { initMcpServer } from '../../../lib/mcp-server';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/**
 * Verify an incoming ****** against our self-hosted OAuth AS.
 *
 * When OAUTH_JWT_SECRET is configured, tokens must be valid HS256 JWTs, and must speak for a
 * person still on ALLOWED_EMAILS or a service client (lib/caller.ts).
 * When it is not configured:
 *   - production: fail closed (return undefined → 401)
 *   - development/test: anonymous access allowed for convenience.
 */
const verifyToken = async (
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  const jwtSecret = process.env['OAUTH_JWT_SECRET'];
  if (!jwtSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      // Fail closed: OAUTH_JWT_SECRET is required in production.
      return undefined;
    }
    // Dev/test convenience: anonymous open access.
    return { token: bearerToken ?? '', clientId: 'anonymous', scopes: ['mcp:read'] };
  }
  const caller = await callerFromToken(bearerToken);
  if (!caller) return undefined;
  return {
    token: bearerToken ?? '',
    clientId: caller.clientId,
    scopes: caller.scopes,
    extra: { person: caller.person, service: caller.service },
  };
};

const handler = createMcpHandler(
  initMcpServer,
  { serverInfo: { name: 'openrouter-registry-mcp', version: '1.0.0' } },
  { basePath: '/api', maxDuration: 60 },
);

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ['mcp:read'],
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
