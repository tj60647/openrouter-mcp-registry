import { createOpenAI } from '@ai-sdk/openai';
import { streamText, jsonSchema, convertToModelMessages, stepCountIs } from 'ai';
import type { UIMessage, JSONSchema7, ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checkRateLimit } from '../../../lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Rate-limit config ─────────────────────────────────────────────────────────
// 20 chat POST requests per minute per IP — each call may spawn multiple LLM
// round-trips and OpenRouter embedding calls, making it a costly operation.
const CHAT_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

// ── Payload constraints ───────────────────────────────────────────────────────
const MAX_BODY_BYTES = 100 * 1024; // 100 KB
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32_768; // 32 KB per individual message content string
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_TEMPERATURE = 2.0;
// Model IDs must follow the "<provider>/<model>" format with safe characters only.
const MODEL_ID_RE = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

/** Returns true when a single text-part content value exceeds the size limit. */
function isOversizedTextPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const p = part as Record<string, unknown>;
  return p['type'] === 'text' && typeof p['text'] === 'string' && p['text'].length > MAX_MESSAGE_CHARS;
}

// ── Config ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are a helpful assistant for the OpenRouter MCP Registry, specializing in helping AI agents and developers build new agents. ` +
  `Imagine you are an AI agent whose job is to help other agents get built: you understand what models are best for specific tasks, how to configure them, and how to write effective system prompts. ` +
  `You help users explore, search, and compare AI models available through OpenRouter — and you can recommend models, provide example system prompts, and suggest configurations for building new agents. ` +
  `\n\nCRITICAL INSTRUCTION: You MUST call the appropriate registry tool before answering ANY question about models, pricing, availability, or specifications. ` +
  `Do NOT answer from your training data — always fetch live data from the registry first, then base your answer on what the tools return. ` +
  `For "latest" or "newest" model questions, call list_models with sortBy: "created_at", sortDir: "desc", limit: 5. ` +
  `For questions about a specific model, call get_model with that model's id. ` +
  `For broad searches (e.g. "latest from Google"), call list_models with the appropriate provider filter. ` +
  `When recommending a model for an agent, verify it is available in the registry before suggesting it. ` +
  `Be concise and practical.`;

const CHAT_MODEL = process.env['CHAT_MODEL'] ?? 'google/gemini-3.5-flash';

const AGENT_PARAMETERS = {
  tool_choice: 'auto',
  max_steps: 10,
  stream: true,
} as const;

// Fallback list used when the DB is unreachable or has no tool-capable models yet.
const FALLBACK_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3-5-haiku',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
] as const;

/** Fetch the current list of tool-capable text models from the MCP server, sorted newest-first. */
async function fetchAvailableModels(): Promise<string[]> {
  try {
    const mcpBase = (process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');
    const res = await fetch(`${mcpBase}/api/models?toolsOnly=true&availableOnly=true&sortBy=newest&sortDir=desc&limit=20`);
    const data = await res.json() as { models?: Array<{ id: string }> };
    const ids = (data.models ?? []).map((m) => m.id);
    // Always include the configured default even if the registry doesn't have it yet.
    if (!ids.includes(CHAT_MODEL)) ids.unshift(CHAT_MODEL);
    return ids;
  } catch {
    const fallback = [...FALLBACK_MODELS] as string[];
    if (!fallback.includes(CHAT_MODEL)) fallback.unshift(CHAT_MODEL);
    return fallback;
  }
}

// ── MCP helpers ───────────────────────────────────────────────────────────────

/**
 * Obtain a bearer token for the MCP server via OAuth client credentials.
 *
 * Uses MCP_CLIENT_ID + MCP_CLIENT_SECRET to request a short-lived JWT from the
 * MCP app's token endpoint. Returns null when credentials are not configured,
 * in which case the connection is made without auth (dev/open mode only).
 */
async function getMcpBearerToken(mcpUrl: string): Promise<string | null> {
  const clientId = process.env['MCP_CLIENT_ID'];
  const clientSecret = process.env['MCP_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;

  try {
    const tokenUrl = `${mcpUrl.replace(/\/$/,"")}/api/oauth/token`;
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'mcp:read',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

/** Create and connect an MCP client to the registry server. */
async function connectMcpClient(mcpUrl: string): Promise<Client> {
  const bearerToken = await getMcpBearerToken(mcpUrl);
  const requestInit: RequestInit = bearerToken
    ? { headers: { Authorization: `Bearer ${bearerToken}` } }
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
  // Fetch tool-capable models and MCP tools concurrently.
  const [availableModels, mcpTools] = await Promise.all([
    fetchAvailableModels(),
    (async (): Promise<Array<{ name: string; description: string }>> => {
      const mcpUrl = process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'];
      if (!mcpUrl) return [];
      const client = await connectMcpClient(mcpUrl).catch(() => null);
      if (!client) return [];
      const listed = await client.listTools().catch(() => ({ tools: [] }));
      await client.close().catch(() => {});
      return listed.tools.map((t: { name: string; description?: string }) => ({ name: t.name, description: t.description ?? '' }));
    })(),
  ]);

  return Response.json({
    model: CHAT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    parameters: AGENT_PARAMETERS,
    availableModels,
    tools: mcpTools,
  });
}

// ── POST – streaming chat ─────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  // ── Rate limiting ───────────────────────────────────────────────────────────
  const forwarded = (req as { headers: Headers }).headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`chat:${ip}`, CHAT_RATE_LIMIT)) {
    return Response.json({ error: 'Too many requests. Please slow down.' }, { status: 429 });
  }

  // ── Prerequisite checks ─────────────────────────────────────────────────────
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    return Response.json({ error: 'OPENROUTER_API_KEY is not configured' }, { status: 503 });
  }

  // MCP_URL (server-side) takes precedence; fall back to the public URL env var
  const mcpUrl = process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'];
  if (!mcpUrl) {
    return Response.json({ error: 'MCP_URL is not configured' }, { status: 503 });
  }

  // ── Payload size guard ──────────────────────────────────────────────────────
  const contentLength = Number((req as { headers: Headers }).headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'Request body too large.' }, { status: 413 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: 'Failed to read request body.' }, { status: 400 });
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return Response.json({ error: 'Request body too large.' }, { status: 413 });
  }

  let parsedBody: { messages: UIMessage[]; model?: string; temperature?: number; maxOutputTokens?: number };
  try {
    parsedBody = JSON.parse(rawBody) as { messages: UIMessage[]; model?: string; temperature?: number; maxOutputTokens?: number };
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  // ── Input validation ────────────────────────────────────────────────────────
  const { messages, model: requestedModel, temperature, maxOutputTokens } = parsedBody;

  if (!Array.isArray(messages)) {
    return Response.json({ error: 'messages must be an array.' }, { status: 400 });
  }
  if (messages.length > MAX_MESSAGES) {
    return Response.json({ error: `Too many messages (max ${MAX_MESSAGES}).` }, { status: 400 });
  }
  for (const msg of messages) {
    const parts: unknown = (msg as { content?: unknown }).content;
    if (typeof parts === 'string' && parts.length > MAX_MESSAGE_CHARS) {
      return Response.json({ error: 'Message content too long.' }, { status: 400 });
    }
    if (Array.isArray(parts) && parts.some(isOversizedTextPart)) {
      return Response.json({ error: 'Message content too long.' }, { status: 400 });
    }
  }

  if (requestedModel !== undefined && !MODEL_ID_RE.test(requestedModel)) {
    return Response.json({ error: 'Invalid model ID.' }, { status: 400 });
  }
  if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > MAX_TEMPERATURE)) {
    return Response.json({ error: `temperature must be a number between 0 and ${MAX_TEMPERATURE}.` }, { status: 400 });
  }
  if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== 'number' || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS)) {
    return Response.json({ error: `maxOutputTokens must be between 1 and ${MAX_OUTPUT_TOKENS}.` }, { status: 400 });
  }

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
      mcpTools.map((t: { name: string; description?: string; inputSchema: unknown }) => [
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
