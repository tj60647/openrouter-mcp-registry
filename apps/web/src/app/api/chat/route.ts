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

// ── Config ────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT =
  `You are a helpful assistant for the OpenRouter MCP Registry. ` +
  `You help users explore, search, and compare AI models available through OpenRouter. ` +
  `Use the provided tools to fetch accurate, up-to-date data from the registry. Be concise and helpful.`;

export const CHAT_MODEL = process.env['CHAT_MODEL'] ?? 'openai/gpt-4o-mini';

export const AGENT_PARAMETERS = {
  tool_choice: 'auto',
  max_steps: 10,
  stream: true,
  include_reasoning: true,
} as const;

// ── SSE helpers ───────────────────────────────────────────────────────────────

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ── GET – agent config ────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  return Response.json({
    model: CHAT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    parameters: AGENT_PARAMETERS,
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

  let userMessages: ChatMessage[];
  try {
    const body = (await req.json()) as unknown;
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) throw new Error('Invalid request body');
    userMessages = parsed.data.messages as ChatMessage[];
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(sseEvent(data)));
      }

      // Send model metadata immediately so the UI can display it
      send({ type: 'model', model: CHAT_MODEL });

      let mcpClient: Client | null = null;
      try {
        mcpClient = await connectMcpClient(mcpUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: `Failed to connect to MCP server: ${message}` });
        controller.close();
        return;
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
        for (let step = 0; step < AGENT_PARAMETERS.max_steps; step++) {
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
              tool_choice: AGENT_PARAMETERS.tool_choice,
              stream: true,
              include_reasoning: true,
            }),
          });

          if (!orResponse.ok) {
            const errText = await orResponse.text();
            send({ type: 'error', message: `OpenRouter error: ${errText}` });
            break;
          }

          // ── Parse the SSE stream from OpenRouter ──────────────────────────

          const reader = orResponse.body!.getReader();
          const dec = new TextDecoder();
          let buf = '';

          // Accumulate tool-call deltas indexed by their position in the array
          const accToolCalls: Record<
            number,
            { id: string; name: string; arguments: string }
          > = {};
          let finishReason: string | null = null;
          let accContent = '';

          parseLoop: while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim();
              if (raw === '[DONE]') break parseLoop;

              let chunk: {
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    reasoning?: string | null;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
              };
              try {
                chunk = JSON.parse(raw) as typeof chunk;
              } catch {
                continue;
              }

              const choice = chunk.choices?.[0];
              if (!choice) continue;

              if (choice.finish_reason) finishReason = choice.finish_reason;

              const delta = choice.delta;
              if (!delta) continue;

              // Reasoning tokens (supported by some models)
              if (delta.reasoning) {
                send({ type: 'reasoning_delta', delta: delta.reasoning });
              }

              // Text content — stream directly to the client
              if (delta.content) {
                accContent += delta.content;
                send({ type: 'text_delta', delta: delta.content });
              }

              // Tool call deltas — accumulate across chunks
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!accToolCalls[idx]) {
                    accToolCalls[idx] = { id: '', name: '', arguments: '' };
                  }
                  if (tc.id) accToolCalls[idx].id = tc.id;
                  if (tc.function?.name) accToolCalls[idx].name += tc.function.name;
                  if (tc.function?.arguments)
                    accToolCalls[idx].arguments += tc.function.arguments;
                }
              }
            }
          }

          const toolCalls = Object.values(accToolCalls);

          // Append the assistant turn to message history
          messages.push({
            role: 'assistant',
            content: accContent || null,
            tool_calls:
              toolCalls.length > 0
                ? toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: tc.arguments },
                  }))
                : undefined,
          });

          // If no tool calls were requested, we're done
          if (toolCalls.length === 0 || finishReason === 'stop') break;

          // Notify the client that we're about to call tools
          for (const tc of toolCalls) {
            send({ type: 'tool_call', name: tc.name, id: tc.id });
          }

          // Execute all tool calls in parallel via the MCP server
          const toolResults = await Promise.all(
            toolCalls.map(async (tc) => {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.arguments) as Record<string, unknown>;
              } catch {
                // use empty args if JSON parsing fails
              }
              try {
                const result = await mcpClient!.callTool({
                  name: tc.name,
                  arguments: args,
                });
                const text = (result.content as Array<{ type: string; text?: string }>)
                  .filter((c) => c.type === 'text' && typeof c.text === 'string')
                  .map((c) => c.text as string)
                  .join('\n');
                const content = text || JSON.stringify(result.content);
                send({ type: 'tool_result', id: tc.id, name: tc.name, content });
                return { tool_call_id: tc.id, content };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const content = JSON.stringify({ error: message });
                send({ type: 'tool_result', id: tc.id, name: tc.name, content, error: true });
                return { tool_call_id: tc.id, content };
              }
            })
          );

          // Append tool results to the conversation history
          for (const tr of toolResults) {
            messages.push({
              role: 'tool',
              tool_call_id: tr.tool_call_id,
              content: tr.content,
            });
          }
        }

        send({ type: 'done' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message });
      } finally {
        await mcpClient.close().catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
