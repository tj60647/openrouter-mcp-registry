import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The demo owns its model (OpenRouter, this site's key) and reaches the registry only through the
// MCP endpoint, with the visitor's own token. The model and the MCP client are stubbed here.
const calls = vi.hoisted(() => ({
  openai: [] as Array<Record<string, unknown>>,
  streamText: [] as Array<Record<string, unknown>>,
  transports: [] as Array<{ url: string; init?: RequestInit }>,
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'tool answer' }] })),
  connect: vi.fn(async () => undefined),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((opts: Record<string, unknown>) => {
    calls.openai.push(opts);
    return { chat: vi.fn((model: string) => `model:${model}`) };
  }),
}));
vi.mock('ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ai')>();
  return {
    ...mod,
    convertToModelMessages: vi.fn(async () => []),
    streamText: vi.fn((opts: Record<string, unknown>) => {
      calls.streamText.push(opts);
      return { toUIMessageStreamResponse: (init?: ResponseInit) => new Response('streamed', init) };
    }),
  };
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => ({
    connect: calls.connect,
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [{ name: 'list_models', description: 'List models', inputSchema: { type: 'object', properties: {} } }] })),
    callTool: calls.callTool,
  })),
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn((url: URL, opts?: { requestInit?: RequestInit }) => {
    calls.transports.push({ url: url.toString(), init: opts?.requestInit });
  }),
}));

function makePostRequest(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function resetCalls() {
  calls.openai.length = 0;
  calls.streamText.length = 0;
  calls.transports.length = 0;
  calls.callTool.mockClear();
  calls.connect.mockReset();
  calls.connect.mockResolvedValue(undefined);
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
    resetCalls();
    signInEnv();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: [{ id: 'x/y' }] })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('signed in, lists the registry’s tools through its MCP endpoint, with the visitor’s own token', async () => {
    const { GET } = await import('../app/api/chat/route');
    const res = await GET(withCookie(new Request('http://localhost/api/chat'), await signedIn(fresh())));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string }>; availableModels: string[]; systemPrompt: string };
    expect(body.tools.map((t) => t.name)).toEqual(['list_models']);
    expect(body.availableModels).toContain('x/y');
    expect(body.systemPrompt).toContain('OpenRouter');
    expect(calls.transports[0]).toEqual({ url: 'http://localhost:3001/api/mcp', init: { headers: { Authorization: 'Bearer visitor-jwt' } } });
  });

  it('signed out, shows the agent’s defaults and asks the registry nothing', async () => {
    const { GET } = await import('../app/api/chat/route');
    const res = await GET(new Request('http://localhost/api/chat'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['model']).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(calls.transports).toHaveLength(0);
  });
});

describe('POST /api/chat', () => {
  beforeEach(() => {
    resetCalls();
    signInEnv();
    vi.stubEnv('OPENROUTER_API_KEY', 'demo-openrouter-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unexpected', { status: 500 })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('asks a visitor who has not signed in to sign in, and runs no model', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('sign_in_required');
    expect(calls.transports).toHaveLength(0);
    expect(calls.streamText).toHaveLength(0);
  });

  it('does not take a tampered cookie', async () => {
    const { POST } = await import('../app/api/chat/route');
    const cookie = (await signedIn(fresh())).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const res = await POST(withCookie(makePostRequest({ messages: [] }), cookie));
    expect(res.status).toBe(401);
    expect(calls.streamText).toHaveLength(0);
  });

  it('runs its own model on its own key, with the registry’s tools reached as the visitor', async () => {
    vi.stubEnv('MCP_CLIENT_ID', 'web-client');
    vi.stubEnv('MCP_CLIENT_SECRET', 'web-secret');
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [], model: 'anthropic/claude-opus-5.5', temperature: 0.3, maxOutputTokens: 512 }), await signedIn(fresh())));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('streamed');
    expect(calls.openai[0]).toEqual({ baseURL: 'https://openrouter.ai/api/v1', apiKey: 'demo-openrouter-key' });
    expect(calls.transports[0]).toEqual({ url: 'http://localhost:3001/api/mcp', init: { headers: { Authorization: 'Bearer visitor-jwt' } } });
    const run = calls.streamText[0]!;
    expect(run['model']).toBe('model:anthropic/claude-opus-5.5');
    expect(run['temperature']).toBe(0.3);
    expect(run['maxOutputTokens']).toBe(512);
    expect(Object.keys(run['tools'] as object)).toEqual(['list_models']);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('a tool the model calls goes to the MCP server', async () => {
    const { POST } = await import('../app/api/chat/route');
    await POST(withCookie(makePostRequest({ messages: [] }), await signedIn(fresh())));
    const tools = calls.streamText[0]!['tools'] as Record<string, { execute: (a: unknown) => Promise<string> }>;
    expect(await tools['list_models']!.execute({ limit: 5 })).toBe('tool answer');
    expect(calls.callTool).toHaveBeenCalledWith({ name: 'list_models', arguments: { limit: 5 } });
  });

  it('is closed, before reaching the registry, while this site has no OpenRouter key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn(fresh())));
    expect(res.status).toBe(503);
    expect(calls.transports).toHaveLength(0);
  });

  it('refreshes a token about to expire, and keeps the new one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'renewed-jwt', refresh_token: 'renewed-refresh', expires_in: 3600 })));
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn({ ...fresh(), expiresAt: Date.now() + 10_000 })));
    expect(res.status).toBe(200);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('http://localhost:3001/api/oauth/token');
    expect(String((init as RequestInit).body)).toContain('grant_type=refresh_token');
    expect(String((init as RequestInit).body)).toContain('client_id=demo-public-client');
    expect(calls.transports[0]?.init).toEqual({ headers: { Authorization: 'Bearer renewed-jwt' } });
    expect(res.headers.get('set-cookie')).toMatch(/^registry_chat=/);
  });

  it('asks the visitor to sign in again when the refresh is refused, or the registry refuses them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    const { POST } = await import('../app/api/chat/route');
    const expired = await signedIn({ ...fresh(), expiresAt: Date.now() - 1 });
    expect((await POST(withCookie(makePostRequest({ messages: [] }), expired))).status).toBe(401);

    calls.connect.mockRejectedValueOnce(new Error('Error POSTing to endpoint (HTTP 401): {"error":"invalid_token"}'));
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn(fresh())));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('sign_in_required');
    expect(calls.streamText).toHaveLength(0);
  });

  it('says so when the registry cannot be reached', async () => {
    calls.connect.mockRejectedValueOnce(new Error('fetch failed'));
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn(fresh())));
    expect(res.status).toBe(502);
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

  // An answer has a length limit even when the visitor sets none (plan step 10).
  it('gives an answer 4,096 tokens when the visitor asks for no length', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [] }), await signedIn(fresh())));
    expect(res.status).toBe(200);
    expect(calls.streamText[0]!['maxOutputTokens']).toBe(4096);
  });

  it('keeps the visitor’s own length up to 16,384 tokens, and refuses more', async () => {
    const { POST } = await import('../app/api/chat/route');
    const cookie = await signedIn(fresh());
    expect((await POST(withCookie(makePostRequest({ messages: [], maxOutputTokens: 16_384 }), cookie))).status).toBe(200);
    expect(calls.streamText[0]!['maxOutputTokens']).toBe(16_384);

    const res = await POST(withCookie(makePostRequest({ messages: [], maxOutputTokens: 16_385 }), cookie));
    expect(res.status).toBe(400);
    expect(calls.streamText).toHaveLength(1);
  });

  // The demo sends messages as the AI SDK does, with their text in `parts` (no `content`).
  const said = (...texts: string[]) => ({ id: 'm1', role: 'user', parts: texts.map((text) => ({ type: 'text', text })) });

  it('refuses a message whose text is longer than 32,768 characters, and runs no model', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [said('x'.repeat(32_769))] }), await signedIn(fresh())));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Message content too long.');
    expect(calls.transports).toHaveLength(0);
    expect(calls.streamText).toHaveLength(0);
  });

  it('counts all the text in a message, across its parts', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [said('x'.repeat(20_000), 'y'.repeat(20_000))] }), await signedIn(fresh())));
    expect(res.status).toBe(400);
    expect(calls.streamText).toHaveLength(0);
  });

  it('takes a message of exactly 32,768 characters', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(withCookie(makePostRequest({ messages: [said('x'.repeat(32_768))] }), await signedIn(fresh())));
    expect(res.status).toBe(200);
    expect(calls.streamText).toHaveLength(1);
  });

  it('takes a long earlier answer in the history, but not a long message from the visitor', async () => {
    const { POST } = await import('../app/api/chat/route');
    const cookie = await signedIn(fresh());
    // Its own address, so this file's requests stay under the 20-a-minute limit for one address.
    const fromOwnAddress = (req: Request) => {
      req.headers.set('x-forwarded-for', '203.0.113.10');
      return req;
    };
    const longAnswer = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(40_000) }] };
    const ok = await POST(fromOwnAddress(withCookie(makePostRequest({ messages: [said('hi'), longAnswer, said('and then?')] }), cookie)));
    expect(ok.status).toBe(200);
    expect(calls.streamText).toHaveLength(1);

    const refused = await POST(fromOwnAddress(withCookie(makePostRequest({ messages: [said('hi'), longAnswer, said('y'.repeat(40_000))] }), cookie)));
    expect(refused.status).toBe(400);
    expect(calls.streamText).toHaveLength(1);
  });
});
