import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { verifyAccessToken } from './oauth';

export const verifyMcpToken = async (
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  const jwtSecret = process.env['OAUTH_JWT_SECRET'];
  if (!jwtSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      return undefined;
    }
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
