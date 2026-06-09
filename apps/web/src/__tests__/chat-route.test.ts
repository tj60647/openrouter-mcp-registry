import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makePostRequest(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('GET /api/chat', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_URL', 'http://localhost:3001');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ model: 'x/y', systemPrompt: 'OpenRouter', parameters: {}, availableModels: ['x/y'], tools: [] })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('proxies the agent configuration from apps/mcp when configured', async () => {
    const { GET } = await import('../app/api/chat/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['model']).toBe('x/y');
    expect(body['systemPrompt']).toContain('OpenRouter');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://localhost:3001/api/chat', { headers: {} });
  });
});

describe('POST /api/chat', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_URL', 'http://localhost:3001');
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('streamed', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('does not require OPENROUTER_API_KEY in apps/web', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('streamed');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
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

  it('returns 400 for a malformed JSON body', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest('this is not json'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid request body');
  });

  it('uses MCP_CLIENT_ID and MCP_CLIENT_SECRET server-side in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MCP_CLIENT_ID', 'web-client');
    vi.stubEnv('MCP_CLIENT_SECRET', 'web-secret');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: 'jwt' }))
        .mockResolvedValueOnce(new Response('streamed', { status: 200 }))
    );

    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));

    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3001/api/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('web-client'),
      })
    );
    expect(vi.mocked(fetch)).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3001/api/chat',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer jwt' }),
      })
    );
  });

  it('fails clearly in production when MCP credentials are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MCP_CLIENT_ID', '');
    vi.stubEnv('MCP_CLIENT_SECRET', '');
    const { POST } = await import('../app/api/chat/route');

    const res = await POST(makePostRequest({ messages: [] }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('authenticate');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('passes chat controls through to apps/mcp', async () => {
    const { POST } = await import('../app/api/chat/route');

    await POST(makePostRequest({ messages: [], model: 'anthropic/claude-sonnet-4-5', temperature: 0.3, maxOutputTokens: 512 }));

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://localhost:3001/api/chat',
      expect.objectContaining({
        body: JSON.stringify({
          messages: [],
          model: 'anthropic/claude-sonnet-4-5',
          temperature: 0.3,
          maxOutputTokens: 512,
        }),
      })
    );
  });
});
