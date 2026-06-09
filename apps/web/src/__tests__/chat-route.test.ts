import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makePostRequest(body: unknown, init?: RequestInit) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

describe('GET /api/chat', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('MCP_URL', 'http://localhost:3001');
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('proxies agent configuration from apps/mcp', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'openai/gpt-4o-mini',
        systemPrompt: 'OpenRouter registry',
        parameters: {},
        availableModels: ['openai/gpt-4o-mini'],
        tools: [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('../app/api/chat/route');
    const res = await GET(new Request('http://localhost/api/chat'));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/chat',
      expect.objectContaining({ method: 'GET' })
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['systemPrompt']).toContain('OpenRouter');
  });
});

describe('POST /api/chat', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('MCP_URL', 'http://localhost:3001');
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not require OPENROUTER_API_KEY in apps/web runtime', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('streamed', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('streamed');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/chat',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns 503 when both MCP_URL and NEXT_PUBLIC_MCP_URL are missing', async () => {
    vi.stubEnv('MCP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('MCP_URL');
  });

  it('normalizes trailing slashes on MCP_URL before proxying to apps/mcp', async () => {
    vi.stubEnv('MCP_URL', 'http://localhost:3001/');
    const fetchMock = vi.fn().mockResolvedValue(new Response('streamed', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../app/api/chat/route');

    await POST(makePostRequest({ messages: [] }));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/chat',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('uses MCP_CLIENT_ID and MCP_CLIENT_SECRET server-side in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MCP_CLIENT_ID', 'web-client');
    vi.stubEnv('MCP_CLIENT_SECRET', 'web-secret');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'mcp-token' }))
      .mockResolvedValueOnce(new Response('streamed', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3001/api/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('web-secret'),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3001/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer mcp-token' }),
      })
    );
  });

  it('returns 502 when production MCP OAuth credentials are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MCP_CLIENT_ID', '');
    vi.stubEnv('MCP_CLIENT_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('MCP');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before proxying', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(
      makePostRequest({ messages: [] }, { headers: { 'content-length': String(101 * 1024) } })
    );

    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
