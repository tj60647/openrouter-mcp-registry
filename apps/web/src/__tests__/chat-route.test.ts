import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@ai-sdk/openai', () => {
  const mockChatFn = vi.fn(() => 'mock-model-instance');
  const mockProvider = Object.assign(
    vi.fn(() => 'mock-model-instance'),
    { chat: mockChatFn }
  );
  return {
    createOpenAI: vi.fn(() => mockProvider),
  };
});

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
    const body = (await res.json()) as Record<string, unknown>;
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
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('OPENROUTER_API_KEY');
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

  it('returns 502 when the MCP server connection fails', async () => {
    mockMcpClient.connect.mockRejectedValueOnce(new Error('Connection refused'));
    const { POST } = await import('../app/api/chat/route');
    const res = await POST(makePostRequest({ messages: [] }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('MCP');
  });

  it('normalizes trailing slashes on MCP_URL before constructing the Streamable HTTP endpoint', async () => {
    vi.stubEnv('MCP_URL', 'http://localhost:3001/');
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { POST } = await import('../app/api/chat/route');

    await POST(makePostRequest({ messages: [] }));

    expect(vi.mocked(StreamableHTTPClientTransport)).toHaveBeenCalledWith(
      new URL('http://localhost:3001/api/mcp'),
      expect.any(Object)
    );
  });

  it('returns 502 instead of anonymously connecting when production MCP OAuth credentials are missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MCP_CLIENT_ID', '');
    vi.stubEnv('MCP_CLIENT_SECRET', '');
    const { POST } = await import('../app/api/chat/route');

    const res = await POST(makePostRequest({ messages: [] }));

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('MCP');
    expect(mockMcpClient.connect).not.toHaveBeenCalled();
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

    // provider.chat() should have been called with the requested model
    const modelFactory = vi.mocked(createOpenAI).mock.results[0]?.value;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((modelFactory as any).chat).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5');
    expect(streamText).toHaveBeenCalled();
  });

  it('falls back to the default model when no model is supplied', async () => {
    const { POST } = await import('../app/api/chat/route');
    const { createOpenAI } = await import('@ai-sdk/openai');

    await POST(makePostRequest({ messages: [] }));

    const modelFactory = vi.mocked(createOpenAI).mock.results[0]?.value;
    // Default is CHAT_MODEL (or the route fallback when unset)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((modelFactory as any).chat).toHaveBeenCalledWith(expect.stringContaining('/'));
  });

  it('passes MCP tools to streamText when the MCP server returns tools', async () => {
    // Arrange: MCP server returns one tool
    mockMcpClient.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'list_models',
          description: 'List available models',
          inputSchema: {
            type: 'object',
            properties: { limit: { type: 'number' } },
          },
        },
      ],
    });

    const { streamText } = await import('ai');
    const { POST } = await import('../app/api/chat/route');

    await POST(makePostRequest({ messages: [] }));

    // streamText must have been called with a non-empty tools object
    expect(vi.mocked(streamText)).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          list_models: expect.objectContaining({
            description: 'List available models',
            execute: expect.any(Function),
          }),
        }),
      })
    );
  });

  it('tool execute function calls mcpClient.callTool and returns text', async () => {
    // Arrange: MCP server returns one tool
    mockMcpClient.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'get_model',
          description: 'Get model by id',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
    });
    mockMcpClient.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"found":true}' }],
    });

    let capturedTools: Record<string, { execute: (args: unknown) => Promise<string> }> | undefined;
    const { streamText } = await import('ai');
    vi.mocked(streamText).mockImplementationOnce((opts) => {
      capturedTools = opts.tools as typeof capturedTools;
      return { toUIMessageStreamResponse: () => new Response('ok', { status: 200 }) } as ReturnType<
        typeof streamText
      >;
    });

    const { POST } = await import('../app/api/chat/route');
    await POST(makePostRequest({ messages: [] }));

    // Call the captured execute function and verify it proxies to callTool
    const result = await capturedTools?.['get_model']?.execute({ id: 'openai/gpt-4o' });
    expect(mockMcpClient.callTool).toHaveBeenCalledWith({
      name: 'get_model',
      arguments: { id: 'openai/gpt-4o' },
    });
    expect(result).toBe('{"found":true}');
  });
});
