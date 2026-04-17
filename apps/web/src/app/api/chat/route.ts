import { z } from 'zod';
import {
  getModels,
  getModelById,
  findModelsByCriteria,
  getSyncStatus,
} from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ToolCallContent[] | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ToolCallContent {
  type: 'text';
  text: string;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_models',
      description: 'List available models in the registry with optional filtering.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (1–100, default 20)' },
          offset: { type: 'number', description: 'Pagination offset (default 0)' },
          provider: { type: 'string', description: 'Filter by provider name (e.g. "anthropic")' },
          query: { type: 'string', description: 'Text search across model ID, name, and provider' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_models',
      description: 'Search for models by name, ID, or provider substring.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search term' },
          limit: { type: 'number', description: 'Max results (1–50, default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_model',
      description: 'Get full details for a single model by its canonical ID.',
      parameters: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Canonical model ID, e.g. "anthropic/claude-sonnet-4-5"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_models_by_criteria',
      description:
        'Filter models by budget and context window requirements. All parameters are optional.',
      parameters: {
        type: 'object',
        properties: {
          maxInputPricePer1k: { type: 'number', description: 'Max input price per 1k tokens (USD)' },
          maxOutputPricePer1k: { type: 'number', description: 'Max output price per 1k tokens (USD)' },
          minContextLength: { type: 'number', description: 'Min context window in tokens' },
          limit: { type: 'number', description: 'Max results (1–50, default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_models',
      description: 'Compare 2–5 models side-by-side on pricing, context length, and metadata.',
      parameters: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of 2–5 canonical model IDs',
            minItems: 2,
            maxItems: 5,
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_registry_status',
      description: 'Get the current sync status of the model registry.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name: string, argsRaw: string): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsRaw) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: 'Failed to parse tool arguments' });
  }

  try {
    switch (name) {
      case 'list_models': {
        const { limit = 20, offset = 0, provider, query } = args as {
          limit?: number; offset?: number; provider?: string; query?: string;
        };
        const models = await getModels({ limit: Math.min(Number(limit), 100), offset: Number(offset), provider, query });
        return JSON.stringify({ models, count: models.length });
      }
      case 'search_models': {
        const { query, limit = 10 } = args as { query?: string; limit?: number };
        if (!query) return JSON.stringify({ error: 'query is required' });
        const models = await getModels({ limit: Math.min(Number(limit), 50), offset: 0, query: String(query) });
        return JSON.stringify({ models, count: models.length });
      }
      case 'get_model': {
        const { id } = args as { id?: string };
        if (!id) return JSON.stringify({ error: 'id is required' });
        const model = await getModelById(String(id));
        return JSON.stringify({ found: model !== null, model });
      }
      case 'find_models_by_criteria': {
        const { maxInputPricePer1k, maxOutputPricePer1k, minContextLength, limit = 10 } = args as {
          maxInputPricePer1k?: number; maxOutputPricePer1k?: number;
          minContextLength?: number; limit?: number;
        };
        const models = await findModelsByCriteria({
          maxInputPricePer1k: maxInputPricePer1k !== undefined ? Number(maxInputPricePer1k) : undefined,
          maxOutputPricePer1k: maxOutputPricePer1k !== undefined ? Number(maxOutputPricePer1k) : undefined,
          minContextLength: minContextLength !== undefined ? Number(minContextLength) : undefined,
          limit: Math.min(Number(limit), 50),
          offset: 0,
        });
        return JSON.stringify({ models, count: models.length });
      }
      case 'compare_models': {
        const { ids } = args as { ids?: string[] };
        if (!Array.isArray(ids)) return JSON.stringify({ error: 'ids must be an array' });
        const results = await Promise.all(
          ids.slice(0, 5).map(async (id) => {
            const model = await getModelById(id);
            return {
              id,
              found: model !== null,
              displayName: model?.displayName ?? null,
              provider: model?.provider ?? null,
              contextLength: model?.contextLength ?? null,
              inputPricePer1k: model?.inputPricePer1k ?? null,
              outputPricePer1k: model?.outputPricePer1k ?? null,
            };
          })
        );
        return JSON.stringify({ comparison: results });
      }
      case 'get_registry_status': {
        const status = await getSyncStatus();
        return JSON.stringify({ status });
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
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

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    return Response.json({ error: 'OPENROUTER_API_KEY is not configured' }, { status: 503 });
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

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...userMessages,
  ];

  // Agentic loop: call OpenRouter, execute tool calls, repeat (up to 10 steps)
  for (let step = 0; step < 10; step++) {
    const orResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://localhost',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages,
        tools: TOOL_DEFINITIONS,
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
      const text = assistantMsg.content ?? '';
      return new Response(text, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => ({
        role: 'tool' as const,
        tool_call_id: tc.id,
        content: await executeTool(tc.function.name, tc.function.arguments),
        // Surface a human-readable label for the frontend
        _toolName: tc.function.name,
      }))
    );

    // Append tool results to the message history
    for (const tr of toolResults) {
      messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
    }
  }

  return Response.json({ error: 'Max tool call steps exceeded' }, { status: 500 });
}
