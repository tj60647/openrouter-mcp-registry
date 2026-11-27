import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makePostRequest(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const SECRET = 'test-chat-session-secret-at-least-32-chars';

/** A visitor's sealed tokens, as the sign-in callback leaves them (lib/chatSignIn.ts). */
async function signedIn(tokens: { access: string; refresh: string | null; expiresAt: number }) {
  const { seal, CHAT_COOKIE } = await import('../lib/chatSignIn');
  return `${CHAT_COOKIE}=${seal(SECRET, 'tokens', tokens)}`;
}
const fresh = () => ({ access: 'visitor-jwt', refresh: 'visitor-refresh', expiresAt: Date.now() + 30 * 60_000 });

function signInEnv() {
  vi.stubEnv('MCP_URL', 'http://localhost:3001');
  vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
  vi.stubEnv('MCP_OAUTH_CLIENT_ID', 'demo-public-client');
  vi.stubEnv('CHAT_SESSION_SECRET', SECRET);
}

function withCookie(req: Request, cookie: string): Request {
  const headers = new Headers(req.headers);
  headers.set('cookie', cookie);
  return new Request(req.url, { method: req.method, headers, body: req.method === 'GET' ? undefined : (req as Request).body, duplex: 'half' } as RequestInit);
}

describe('GET /api/chat', () => {
  beforeEach(() => {
    signInEnv();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ model: 'x/y', systemPrompt: 'OpenRouter', parameters: {}, availableModels: ['x/y'], tools: [] })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('signed in, proxies the agent configuration from apps/mcp with the visitor’s own token', async () => {
    const { GET } = await import('../app/api/chat/route');
    const res = await GET(withCookie(new Request('http://localhost/api/chat'), await signedIn(fresh())));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['model']).toBe('x/y');
    expect(body['systemPrompt']).toContain('OpenRouter');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://localhost:3001/api/chat', { headers: { Authorization: 'Bearer visitor-jwt' } });
  });

  it('signed out, shows the agent’s defaults and asks apps/mcp nothing', async () => {
    const { GET } = await import('../app/api/chat/route');
    const res = await GET(new Request('http://localhost/api/chat'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['model']).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('POST /api/chat', () => {
  beforeEach(() => {
    signInEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('streamed', { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('asks a visitor who has not signed in to sign in, and sends nothing on', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('sign_in_required');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not take a tampered cookie', async () => {
    const { POST } = await import('../app/api/chat/route');
    const cookie = (await signedIn(fresh())).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const res = await POST(withCookie(makePostRequest({ messages: [] }), cookie));
    expect(res.status).toBe(401);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('sends a signed-in visitor’s message with their own token, never a service credential', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('MCP_CLIENT_ID', 'web-client');
    vi.stubEnv('MCP_CLIENT_SECRET', 'web-secret');
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn(fresh())));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('streamed');
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://localhost:3001/api/chat',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer visitor-jwt' }) })
    );
  });

  it('refreshes a token about to expire, and keeps the new one', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ access_token: 'renewed-jwt', refresh_token: 'renewed-refresh', expires_in: 3600 }))
        .mockResolvedValueOnce(new Response('streamed', { status: 200 }))
    );
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn({ ...fresh(), expiresAt: Date.now() + 10_000 })));
    expect(res.status).toBe(200);
    const [first, second] = vi.mocked(fetch).mock.calls;
    expect(first?.[0]).toBe('http://localhost:3001/api/oauth/token');
    expect(String((first?.[1] as RequestInit).body)).toContain('grant_type=refresh_token');
    expect(String((first?.[1] as RequestInit).body)).toContain('client_id=demo-public-client');
    expect((second?.[1] as { headers: Record<string, string> }).headers['Authorization']).toBe('Bearer renewed-jwt');
    expect(res.headers.get('set-cookie')).toMatch(/^registry_chat=/);
  });

  it('asks the visitor to sign in again when the refresh is refused, or apps/mcp refuses them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    const { POST } = await import('../app/api/chat/route');
    const expired = await signedIn({ ...fresh(), expiresAt: Date.now() - 1 });
    expect((await POST(withCookie(makePostRequest({ messages: [] }), expired))).status).toBe(401);

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Unauthorized' }, { status: 401 })));
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn(fresh())));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('sign_in_required');
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

  it('passes chat controls through to apps/mcp, any model', async () => {
    const { POST } = await import('../app/api/chat/route');

    await POST(withCookie(makePostRequest({ messages: [], model: 'anthropic/claude-sonnet-4-5', temperature: 0.3, maxOutputTokens: 512 }), await signedIn(fresh())));

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
