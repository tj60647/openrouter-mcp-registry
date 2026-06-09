import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyMcpToken } from '../lib/mcpAuth';

describe('/api/mcp auth boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects anonymous MCP requests in production when OAUTH_JWT_SECRET is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OAUTH_JWT_SECRET', 'test-jwt-secret-at-least-32-bytes-long!!');

    const auth = await verifyMcpToken(new Request('https://mcp.example.com/api/mcp'));

    expect(auth).toBeUndefined();
  });

  it('allows anonymous MCP requests in local development when OAuth is intentionally unset', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OAUTH_JWT_SECRET', '');

    const auth = await verifyMcpToken(new Request('http://localhost:3001/api/mcp'));

    expect(auth?.clientId).toBe('anonymous');
    expect(auth?.scopes).toContain('mcp:read');
  });
});
