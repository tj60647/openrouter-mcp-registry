import { createOpenAI } from '@ai-sdk/openai';
import { streamText, jsonSchema, convertToModelMessages, stepCountIs } from 'ai';
import type { UIMessage, JSONSchema7, ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Config ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are a helpful assistant for the OpenRouter MCP Registry. ` +
  `You help users explore, search, and compare AI models available through OpenRouter. ` +
  `Use the provided tools to fetch accurate, up-to-date data from the registry. Be concise and helpful.`;

const CHAT_MODEL = process.env['CHAT_MODEL'] ?? 'openai/gpt-4o-mini';

const AGENT_PARAMETERS = {
  tool_choice: 'auto',
  max_steps: 10,
  stream: true,
} as const;

const AVAILABLE_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'openai/o4-mini',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-3-5-haiku',
  'google/gemini-2.0-flash-001',
  'google/gemini-2.5-pro-preview-03-25',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat-v3-0324',
] as const;

// ── MCP helpers ───────────────────────────────────────────────────────────────

/** Create and connect an MCP client to the registry server. */
async function connectMcpClient(mcpUrl: string): Promise<Client> {
  const mcpApiKey = process.env['MCP_API_KEY'];
  const requestInit: RequestInit = mcpApiKey
    ? { headers: { Authorization: `Bearer ${mcpApiKey}` } }
    : {};

  let endpoint: URL;
  try {
    endpoint = new URL(`${mcpUrl}/api/mcp`);
  } catch {
    throw new Error(`MCP_URL is not a valid URL: "${mcpUrl}"`);
  }

  const client = new Client({ name: 'web-demo', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit });
  await client.connect(transport);
  return client;
}

// ── GET – agent config ────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  // Try to list tools from the MCP server; fall back to empty array on any failure.
  let mcpTools: Array<{ name: string; description: string }> = [];
  const mcpUrl = process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'];
  if (mcpUrl) {
    const client = await connectMcpClient(mcpUrl).catch(() => null);
    if (client) {
      const listed = await client.listTools().catch(() => ({ tools: [] }));
      mcpTools = listed.tools.map((t) => ({ name: t.name, description: t.description ?? '' }));
      await client.close().catch(() => {});
    }
  }

  return Response.json({
    model: CHAT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    parameters: AGENT_PARAMETERS,
    availableModels: AVAILABLE_MODELS,
    tools: mcpTools,
  });
}

// ── POST – streaming chat ─────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    return Response.json({ error: 'OPENROUTER_API_KEY is not configured' }, { status: 503 });
  }

  // MCP_URL (server-side) takes precedence; fall back to the public URL env var
  const mcpUrl = process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'];
  if (!mcpUrl) {
    return Response.json({ error: 'MCP_URL is not configured' }, { status: 503 });
  }

  let parsedBody: { messages: UIMessage[]; model?: string; temperature?: number; maxOutputTokens?: number };
  try {
    parsedBody = (await req.json()) as { messages: UIMessage[]; model?: string; temperature?: number; maxOutputTokens?: number };
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { messages, model: requestedModel, temperature, maxOutputTokens } = parsedBody;
  const chatModel = requestedModel ?? CHAT_MODEL;

  const mcpClient = await connectMcpClient(mcpUrl).catch((err: unknown) => {
    console.error('[chat/route] MCP connection failed:', err instanceof Error ? err.message : err);
    return null;
  });
  if (!mcpClient) {
    return Response.json({ error: 'Failed to connect to the MCP registry server.' }, { status: 502 });
  }

  try {
    // Discover tools dynamically from the MCP server and bridge them to AI SDK format
    const { tools: mcpTools } = await mcpClient.listTools();

    const tools: ToolSet = Object.fromEntries(
      mcpTools.map((t) => [
        t.name,
        {
          description: t.description ?? '',
          inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
          execute: async (args: unknown): Promise<string> => {
            const result = await mcpClient.callTool({
              name: t.name,
              arguments: args as Record<string, unknown>,
            });
            const text = (result.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n');
            return text || JSON.stringify(result.content);
          },
        },
      ])
    );

    const openrouter = createOpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
      headers: {
        'HTTP-Referer': process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://localhost',
      },
    });

    const result = streamText({
      model: openrouter.chat(chatModel),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      tools,
      temperature,
      maxOutputTokens,
      stopWhen: stepCountIs(AGENT_PARAMETERS.max_steps),
      onFinish: async () => {
        await mcpClient.close().catch(() => {});
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    await mcpClient.close().catch(() => {});
    throw err;
  }
}
