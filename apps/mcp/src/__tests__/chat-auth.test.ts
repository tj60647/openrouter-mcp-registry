import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ chat: vi.fn(() => 'mock-model') })),
}));

vi.mock('ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ai')>();
  return {
    ...mod,
    streamText: vi.fn(() => ({ toUIMessageStreamResponse: () => new Response('streamed') })),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    callTool: vi.fn(),
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

function makePostRequest(headers?: HeadersInit) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify({ messages: [] }),
  });
}

describe('apps/mcp /api/chat auth boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects anonymous chat requests in production when OAUTH_JWT_SECRET is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OAUTH_JWT_SECRET', 'test-jwt-secret-at-least-32-bytes-long!!');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    const { POST } = await import('../app/api/chat/route');

    const res = await POST(makePostRequest());

    expect(res.status).toBe(401);
  });

  it('allows local development without OAuth credentials when OAUTH_JWT_SECRET is absent', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OAUTH_JWT_SECRET', '');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    vi.stubEnv('MCP_URL', 'http://localhost:3001');
    const { POST } = await import('../app/api/chat/route');

    const res = await POST(makePostRequest());

    expect(res.status).toBe(200);
  });
});
