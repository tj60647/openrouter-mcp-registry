/**
 * @file mcpAuth.test.ts
 * Tests for the service-token helper apps/web uses to call apps/mcp.
 *
 * The caching is not an optimisation, it is a correctness fix. apps/mcp's token
 * endpoint is limited per source address, and every request apps/web makes
 * leaves from the same address. Minting a fresh token per request was merely
 * wasteful while that limit lived in per-lambda memory; once it became a shared
 * Postgres counter the limit began to bind, and apps/web's own traffic was the
 * first thing it would have throttled.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMcpBearerToken, resetMcpTokenCache } from '../lib/mcpAuth';

const mockFetch = vi.fn();

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getMcpBearerToken', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('MCP_CLIENT_ID', 'svc');
    vi.stubEnv('MCP_CLIENT_SECRET', 'shh');
    resetMcpTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetMcpTokenCache();
  });

  it('requests a token on the first call', async () => {
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1'));

    await expect(getMcpBearerToken('http://mcp.test')).resolves.toBe('tok-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not mint a new token for every request', async () => {
    mockFetch.mockImplementation(async () => tokenResponse('tok-1'));

    for (let i = 0; i < 25; i += 1) await getMcpBearerToken('http://mcp.test');

    // 25 requests is above the token endpoint's 20-per-minute budget. Without
    // the cache this loop alone would have throttled apps/web against apps/mcp.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('mints a fresh token once the cached one is close to expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1', 3600));
    await getMcpBearerToken('http://mcp.test');

    vi.setSystemTime(new Date('2026-07-29T00:59:30Z'));
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-2', 3600));

    await expect(getMcpBearerToken('http://mcp.test')).resolves.toBe('tok-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('renews before the token actually expires, not after', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1', 120));
    await getMcpBearerToken('http://mcp.test');

    // 90s in: the token is still valid for 30s, but inside the refresh margin,
    // so an in-flight request can never carry one that dies mid-flight.
    vi.setSystemTime(new Date('2026-07-29T00:01:30Z'));
    mockFetch.mockResolvedValueOnce(tokenResponse('tok-2', 120));

    await expect(getMcpBearerToken('http://mcp.test')).resolves.toBe('tok-2');
  });

  it('does not cache a token whose lifetime is shorter than the refresh margin', async () => {
    // A fresh Response per call: a body can only be read once.
    mockFetch.mockImplementation(async () => tokenResponse('tok-short', 10));

    await getMcpBearerToken('http://mcp.test');
    await getMcpBearerToken('http://mcp.test');

    // Caching it would mean serving a token already past the margin.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed token request', async () => {
    mockFetch.mockResolvedValueOnce(new Response('nope', { status: 429 }));

    await expect(getMcpBearerToken('http://mcp.test')).rejects.toThrow(/429/);

    mockFetch.mockResolvedValueOnce(tokenResponse('tok-1'));
    await expect(getMcpBearerToken('http://mcp.test')).resolves.toBe('tok-1');
  });

  it('still fails closed in production when credentials are absent', async () => {
    vi.stubEnv('MCP_CLIENT_ID', '');
    vi.stubEnv('MCP_CLIENT_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');

    await expect(getMcpBearerToken('http://mcp.test')).rejects.toThrow(/must be configured/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
