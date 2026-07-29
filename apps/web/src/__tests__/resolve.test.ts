/**
 * @file resolve.test.ts
 * Tests for apps/web /api/resolve, which is a pure proxy that forwards a JSON
 * body to apps/mcp and hands the upstream answer back to the browser. Nothing
 * about model resolution happens in apps/web, so everything asserted here is
 * about the proxy contract: where the upstream URL comes from, that the body
 * crosses over untouched, and that the upstream status is not laundered.
 *
 * Rewritten because the previous version of this file constructed its own
 * ModelRegistry with a fake findById and asserted against that, while claiming
 * to mirror the route. The route has never contained a ModelRegistry, so those
 * tests duplicated packages/shared/src/__tests__/modelRegistry.test.ts and
 * would have stayed green with the route entirely broken. Please do not restore
 * a version of this file that tests a local re-implementation.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/resolve/route';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();

// vi.stubEnv in vitest 1.x stringifies its value, so it cannot express "this
// variable is absent". The fallback-to-localhost path only exists when both
// variables are genuinely unset, so the originals are captured once and the
// variables are deleted for the duration of the suite.
const originalEnv = {
  MCP_URL: process.env['MCP_URL'],
  NEXT_PUBLIC_MCP_URL: process.env['NEXT_PUBLIC_MCP_URL'],
};

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function firstCall(): [string, RequestInit] {
  return mockFetch.mock.calls[0] as [string, RequestInit];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/resolve (web proxy)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    delete process.env['MCP_URL'];
    delete process.env['NEXT_PUBLIC_MCP_URL'];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // ── Upstream address ────────────────────────────────────────────────────────

  it('sends the resolution request to the configured MCP host', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test');
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 'a/b' }, 200));

    await POST(makePostRequest({ input: 'a/b' }));

    const [url] = firstCall();
    expect(url).toBe('http://mcp.test/api/resolve');
    // A deployment that silently kept talking to the dev default would look
    // healthy in tests but resolve against nothing in production.
    expect(url).not.toContain('localhost');
  });

  it('falls back to NEXT_PUBLIC_MCP_URL when the server-only variable is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', 'http://public-mcp.test');
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 'a/b' }, 200));

    await POST(makePostRequest({ input: 'a/b' }));

    const [url] = firstCall();
    expect(url).toBe('http://public-mcp.test/api/resolve');
  });

  it('prefers the server-only MCP_URL over the public one when both are set', async () => {
    vi.stubEnv('MCP_URL', 'http://private-mcp.test');
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', 'http://public-mcp.test');
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 'a/b' }, 200));

    await POST(makePostRequest({ input: 'a/b' }));

    const [url] = firstCall();
    expect(url).toBe('http://private-mcp.test/api/resolve');
    expect(url).not.toContain('public-mcp.test');
  });

  it('falls back to the local dev host when no MCP URL is configured', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 'a/b' }, 200));

    await POST(makePostRequest({ input: 'a/b' }));

    const [url] = firstCall();
    expect(url).toBe('http://localhost:3001/api/resolve');
  });

  it('never doubles the slash when the configured host ends in slashes', async () => {
    // Copy-pasted dashboard values routinely carry a trailing slash; the upstream
    // router treats //api/resolve as a different path and 404s.
    vi.stubEnv('MCP_URL', 'http://mcp.test///');
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 'a/b' }, 200));

    await POST(makePostRequest({ input: 'a/b' }));

    const [url] = firstCall();
    expect(url).toBe('http://mcp.test/api/resolve');
    expect(url).not.toContain('//api');
  });

  // ── Request forwarding ──────────────────────────────────────────────────────

  it('forwards the caller body to apps/mcp without altering it', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test');
    mockFetch.mockResolvedValueOnce(jsonResponse({ resolved: 'anthropic/claude-sonnet-4-5' }, 200));
    const payload = { input: 'claude sonnet 4.5', includeMetadata: true, limit: 3 };

    await POST(makePostRequest(payload));

    const [, init] = firstCall();
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    // Deep equality rather than string equality so a hint field being dropped on
    // the way through is caught, not just a reformatting of the JSON.
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  // ── Response passthrough ────────────────────────────────────────────────────

  it('returns the upstream resolution body to the caller unchanged', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test');
    const upstream = {
      resolved: 'anthropic/claude-sonnet-4-5',
      source: 'alias',
      model: { id: 'anthropic/claude-sonnet-4-5', contextLength: 200000 },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse(upstream, 200));

    const res = await POST(makePostRequest({ input: 'claude sonnet 4.5' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstream);
  });

  it('does not launder an upstream 404 into a 200', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test');
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'Model not found' }, 404));

    const res = await POST(makePostRequest({ input: 'nonexistent-model' }));

    // The caller decides between "no match" and "match" from the status, so a
    // flattened 200 would make every unknown model look resolvable.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Model not found');
  });

  it('does not launder an upstream 400 into a 200', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test');
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'input is required' }, 400));

    const res = await POST(makePostRequest({ nothing: true }));

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(400);
  });

  // ── Failure paths ───────────────────────────────────────────────────────────

  it('rejects a malformed request body before contacting apps/mcp', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test');

    const res = await POST(makePostRequest('this is not json'));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
    // Garbage from the browser must not be turned into upstream traffic.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports the failure instead of an empty success when the MCP host is unreachable', async () => {
    vi.stubEnv('MCP_URL', 'http://mcp.test');
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

    const res = await POST(makePostRequest({ input: 'a/b' }));

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('fetch failed');
  });

  it('reports a failure when the upstream answers with something other than JSON', async () => {
    // A platform error page (HTML) reaches res.json() with a 2xx status; without
    // the catch that would surface as a successful resolution with no fields.
    vi.stubEnv('MCP_URL', 'http://mcp.test');
    mockFetch.mockResolvedValueOnce(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const res = await POST(makePostRequest({ input: 'a/b' }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { resolved?: string; error: string };
    expect(body.error).toBeTruthy();
    expect(body.resolved).toBeUndefined();
  });
});
