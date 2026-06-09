import { initMcpServer } from '../../../lib/mcp-server';
import { verifyMcpToken } from '../../../lib/mcpAuth';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';

const handler = createMcpHandler(
  initMcpServer,
  { serverInfo: { name: 'openrouter-mcp-registry', version: '1.0.0' } },
  { basePath: '/api', maxDuration: 60 }
);

const authHandler = withMcpAuth(handler, verifyMcpToken, {
  required: true,
  requiredScopes: ['mcp:read'],
  resourceMetadataPath: '/.well-known/oauth-protected-resource',
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
