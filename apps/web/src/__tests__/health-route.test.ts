/**
 * @file health-route.test.ts
 * Tests for apps/web /api/health, which proxies the MCP host's health check.
 *
 * Two things are load-bearing here: the upstream status must pass through
 * unchanged (so a 503 from apps/mcp is not laundered into a 200), and the
 * route's own failure path must answer 503 rather than 200.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '../app/api/health/route';

const mockFetch = vi.fn();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GET /api/health (web proxy)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.stubEnv('MCP_URL', 'http://mcp.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('passes a healthy upstream response through as 200', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok', syncStatus: null }, 200));

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('does not launder an upstream 503 into a 200', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'degraded', error: 'db down' }, 503));

    const res = await GET();

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('db down');
  });

  it('answers 503, not 200, when the MCP host is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

    const res = await GET();

    // The defect in one assertion.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe('degraded');
    expect(body.error).toContain('fetch failed');
  });

  it('answers 503 when the upstream body is not JSON', async () => {
    // A Vercel platform error serves an HTML page, which res.json() rejects on.
    // That used to surface as a 200 saying the service was merely degraded.
    mockFetch.mockResolvedValueOnce(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const res = await GET();

    expect(res.status).toBe(503);
  });

  it('bounds the upstream request so a hung host fails instead of hanging', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok' }, 200));

    await GET();

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('strips trailing slashes from the configured MCP URL', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test///');
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ok' }, 200));

    await GET();

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('http://mcp.test/api/health');
  });
});
