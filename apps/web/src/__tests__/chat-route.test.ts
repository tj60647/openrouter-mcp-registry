import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => 'mock-model-instance')),
}));

vi.mock('ai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('ai')>();
  return {
    ...mod,
    streamText: vi.fn(() => ({
      toUIMessageStreamResponse: () => new Response('streamed', { status: 200 }),
    })),
  };
});

const mockMcpClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({ tools: [] }),
  callTool: vi.fn(),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(() => mockMcpClient),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePostRequest(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/chat', () => {
  it('returns the agent configuration including an empty tools array when MCP is not configured', async () => {
    const { GET } = await import('../app/api/chat/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body['model']).toBe('string');
    expect(body['systemPrompt']).toContain('OpenRouter');
    expect(body['parameters']).toBeDefined();
    expect(Array.isArray(body['availableModels'])).toBe(true);
    expect((body['availableModels'] as string[]).length).toBeGreaterThan(0);
    // tools is always an array; empty when MCP not configured in this test env
    expect(Array.isArray(body['tools'])).toBe(true);
  });
});

describe('POST /api/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    vi.stubEnv('MCP_URL', 'http://localhost:3001');
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    mockMcpClient.connect.mockResolvedValue(undefined);
    mockMcpClient.listTools.mockResolvedValue({ tools: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 503 when OPENROUTER_API_KEY is missing', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('OPENROUTER_API_KEY');
  });

  it('returns 503 when both MCP_URL and NEXT_PUBLIC_MCP_URL are missing', async () => {
    vi.stubEnv('MCP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_MCP_URL', '');
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('MCP_URL');
  });

  it('returns 400 for a malformed JSON body', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest('this is not json'));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid request body');
  });

  it('returns 502 when the MCP server connection fails', async () => {
    mockMcpClient.connect.mockRejectedValueOnce(new Error('Connection refused'));
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('MCP');
  });

  it('returns a streaming response for a valid request', async () => {
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(200);
  });

  it('passes temperature and maxOutputTokens to streamText when provided', async () => {
    const { streamText } = await import('ai');
    const { POST } = await import('../app/api/chat/route');

    await POST(makePostRequest({ messages: [], temperature: 0.3, maxOutputTokens: 512 }));

    expect(vi.mocked(streamText)).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.3, maxOutputTokens: 512 })
    );
  });

  it('passes undefined temperature and maxOutputTokens when not provided', async () => {
    const { streamText } = await import('ai');
    const { POST } = await import('../app/api/chat/route');

    await POST(makePostRequest({ messages: [] }));

    expect(vi.mocked(streamText)).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: undefined, maxOutputTokens: undefined })
    );
  });

  it('uses a client-supplied model when provided in the request body', async () => {
    const { streamText } = await import('ai');
    const { POST } = await import('../app/api/chat/route');
    const { createOpenAI } = await import('@ai-sdk/openai');

    await POST(makePostRequest({ messages: [], model: 'anthropic/claude-sonnet-4-5' }));

    // The model factory should have been called with the requested model
    const modelFactory = vi.mocked(createOpenAI).mock.results[0]?.value as ReturnType<typeof createOpenAI>;
    expect(vi.mocked(modelFactory)).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5');
    expect(streamText).toHaveBeenCalled();
  });

  it('falls back to the default model when no model is supplied', async () => {
    const { POST } = await import('../app/api/chat/route');
    const { createOpenAI } = await import('@ai-sdk/openai');

    await POST(makePostRequest({ messages: [] }));

    const modelFactory = vi.mocked(createOpenAI).mock.results[0]?.value as ReturnType<typeof createOpenAI>;
    // Default is openai/gpt-4o-mini (or whatever CHAT_MODEL env var resolves to)
    expect(vi.mocked(modelFactory)).toHaveBeenCalledWith(
      expect.stringContaining('/')
    );
  });
});
