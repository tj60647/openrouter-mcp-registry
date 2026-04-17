import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ── MCP helpers ───────────────────────────────────────────────────────────────

type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

/** Convert MCP tool schemas to OpenAI function-calling format. */
function mcpToolsToOpenAI(tools: McpTool[]) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema,
    },
  }));
}

/** Create and connect an MCP client to the registry server. */
async function connectMcpClient(mcpUrl: string): Promise<Client> {
  const mcpApiKey = process.env['MCP_API_KEY'];
  const requestInit: RequestInit = mcpApiKey
    ? { headers: { Authorization: `Bearer ${mcpApiKey}` } }
    : {};

  const client = new Client({ name: 'web-demo', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${mcpUrl}/api/mcp`),
    { requestInit }
  );
  await client.connect(transport);
  return client;
}

// ── Request schema ────────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().nullable(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
});

const RequestSchema = z.object({
  messages: z.array(MessageSchema).min(1),
});

// ── Route handler ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are a helpful assistant for the OpenRouter MCP Registry. ` +
  `You help users explore, search, and compare AI models available through OpenRouter. ` +
  `Use the provided tools to fetch accurate, up-to-date data from the registry. Be concise and helpful.`;

const CHAT_MODEL = process.env['CHAT_MODEL'] ?? 'openai/gpt-4o-mini';

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

  let userMessages: ChatMessage[];
  try {
    const body = await req.json() as unknown;
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) throw new Error('Invalid request body');
    userMessages = parsed.data.messages as ChatMessage[];
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Connect to the MCP server for this request
  let mcpClient: Client;
  try {
    mcpClient = await connectMcpClient(mcpUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Failed to connect to MCP server: ${message}` }, { status: 502 });
  }

  try {
    // Discover tools dynamically from the MCP server
    const { tools: mcpTools } = await mcpClient.listTools();
    const toolDefinitions = mcpToolsToOpenAI(mcpTools as McpTool[]);

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...userMessages,
    ];

    // Agentic loop: call OpenRouter, execute tool calls via MCP, repeat (up to 10 steps)
    for (let step = 0; step < 10; step++) {
      const orResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://localhost',
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages,
          tools: toolDefinitions,
          tool_choice: 'auto',
          stream: false,
        }),
      });

      if (!orResponse.ok) {
        const errText = await orResponse.text();
        return Response.json({ error: `OpenRouter error: ${errText}` }, { status: 502 });
      }

      const orData = await orResponse.json() as {
        choices?: Array<{
          message?: {
            role: string;
            content: string | null;
            tool_calls?: ToolCall[];
          };
          finish_reason?: string;
        }>;
      };

      const choice = orData.choices?.[0];
      const assistantMsg = choice?.message;
      if (!assistantMsg) {
        return Response.json({ error: 'No response from model' }, { status: 502 });
      }

      messages.push({
        role: 'assistant',
        content: assistantMsg.content ?? null,
        tool_calls: assistantMsg.tool_calls,
      });

      // If no tool calls or finish_reason is stop, return the final text
      const toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0 || choice?.finish_reason === 'stop') {
        return new Response(assistantMsg.content ?? '', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      // Execute all tool calls in parallel via the MCP server
      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // use empty args if JSON parsing fails
          }
          try {
            const result = await mcpClient.callTool({ name: tc.function.name, arguments: args });
            const text = (result.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n');
            return {
              tool_call_id: tc.id,
              content: text || JSON.stringify(result.content),
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { tool_call_id: tc.id, content: JSON.stringify({ error: message }) };
          }
        })
      );

      // Append tool results to the message history
      for (const tr of toolResults) {
        messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
      }
    }

    return Response.json({ error: 'Max tool call steps exceeded' }, { status: 500 });
  } finally {
    await mcpClient.close().catch(() => {});
  }
}
