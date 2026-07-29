import { createOpenAI } from '@ai-sdk/openai';
import { streamText, jsonSchema, convertToModelMessages, stepCountIs } from 'ai';
import type { UIMessage, JSONSchema7, ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { verifyAccessToken } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BODY_BYTES = 100 * 1024;
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32_768;
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_TEMPERATURE = 2.0;
const MODEL_ID_RE = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

/** Cached service token, reused across requests on a warm instance. */
let cachedServiceToken: { value: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const SYSTEM_PROMPT =
  `You are a helpful assistant for the OpenRouter Registry MCP, specializing in helping AI agents and developers build new agents. ` +
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
const AGENT_PARAMETERS = { tool_choice: 'auto', max_steps: 10, stream: true } as const;
const FALLBACK_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3-5-haiku',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
] as const;

function isOversizedTextPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const p = part as Record<string, unknown>;
  return p['type'] === 'text' && typeof p['text'] === 'string' && p['text'].length > MAX_MESSAGE_CHARS;
}

function getMcpBaseUrl(): string {
  const configured = process.env['MCP_URL'] ?? process.env['NEXT_PUBLIC_MCP_URL'];
  if (configured) return configured.replace(/\/+$/, '');
  const vercelUrl = process.env['VERCEL_URL'];
  if (vercelUrl) return `https://${vercelUrl}`.replace(/\/+$/, '');
  return 'http://localhost:3001';
}

async function requireRouteAuth(req: Request): Promise<Response | null> {
  const jwtSecret = process.env['OAUTH_JWT_SECRET'];
  if (!jwtSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      return Response.json({ error: 'MCP auth is not configured' }, { status: 503 });
    }
    return null;
  }

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const claims = await verifyAccessToken(token);
    const scopes = (claims.scope ?? '').split(' ').filter(Boolean);
    if (!scopes.includes('mcp:read')) return Response.json({ error: 'Forbidden' }, { status: 403 });
    return null;
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

async function getMcpBearerToken(mcpUrl: string): Promise<string | null> {
  const clientId = process.env['MCP_CLIENT_ID'];
  const clientSecret = process.env['MCP_CLIENT_SECRET'];
  if (!clientId && !clientSecret) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('MCP_CLIENT_ID and MCP_CLIENT_SECRET must be configured for production MCP access.');
    }
    return null;
  }
  if (!clientId || !clientSecret) {
    throw new Error('Both MCP_CLIENT_ID and MCP_CLIENT_SECRET must be configured together.');
  }

  // Reuse the token until shortly before it expires. This route calls its own
  // host's token endpoint, which is rate limited per source address, so minting
  // one per chat message would spend that budget on itself. Mirrors the cache in
  // apps/web/src/lib/mcpAuth.ts.
  if (cachedServiceToken && Date.now() < cachedServiceToken.expiresAt) {
    return cachedServiceToken.value;
  }

  const res = await fetch(`${mcpUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'mcp:read' }),
  });
  if (!res.ok) throw new Error(`MCP OAuth token request failed with status ${res.status}.`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  const token = data.access_token ?? null;
  if (token) {
    const ttlMs = Math.min((data.expires_in ?? 3600) * 1000, 3600_000) - TOKEN_REFRESH_MARGIN_MS;
    if (ttlMs > 0) cachedServiceToken = { value: token, expiresAt: Date.now() + ttlMs };
  }
  return token;
}

async function connectMcpClient(mcpUrl: string): Promise<Client> {
  const normalizedMcpUrl = mcpUrl.replace(/\/+$/, '');
  const bearerToken = await getMcpBearerToken(normalizedMcpUrl);
  const requestInit: RequestInit = bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : {};
  const client = new Client({ name: 'mcp-chat', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${normalizedMcpUrl}/api/mcp`), { requestInit });
  await client.connect(transport);
  return client;
}

async function fetchAvailableModels(): Promise<string[]> {
  try {
    const res = await fetch(`${getMcpBaseUrl()}/api/models?toolsOnly=true&availableOnly=true&sortBy=newest&sortDir=desc&limit=20`);
    const data = (await res.json()) as { models?: Array<{ id: string }> };
    const ids = (data.models ?? []).map((m) => m.id);
    if (!ids.includes(CHAT_MODEL)) ids.unshift(CHAT_MODEL);
    return ids;
  } catch {
    const fallback = [...FALLBACK_MODELS] as string[];
    if (!fallback.includes(CHAT_MODEL)) fallback.unshift(CHAT_MODEL);
    return fallback;
  }
}

export async function GET(req: Request): Promise<Response> {
  const authError = await requireRouteAuth(req);
  if (authError) return authError;

  const [availableModels, mcpTools] = await Promise.all([
    fetchAvailableModels(),
    (async (): Promise<Array<{ name: string; description: string }>> => {
      const client = await connectMcpClient(getMcpBaseUrl()).catch(() => null);
      if (!client) return [];
      const listed = await client.listTools().catch(() => ({ tools: [] }));
      await client.close().catch(() => {});
      return listed.tools.map((t: { name: string; description?: string }) => ({ name: t.name, description: t.description ?? '' }));
    })(),
  ]);

  return Response.json({ model: CHAT_MODEL, systemPrompt: SYSTEM_PROMPT, parameters: AGENT_PARAMETERS, availableModels, tools: mcpTools });
}

export async function POST(req: Request): Promise<Response> {
  const authError = await requireRouteAuth(req);
  if (authError) return authError;

  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) return Response.json({ error: 'OPENROUTER_API_KEY is not configured' }, { status: 503 });

  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: 'Request body too large.' }, { status: 413 });

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: 'Failed to read request body.' }, { status: 400 });
  }
  if (rawBody.length > MAX_BODY_BYTES) return Response.json({ error: 'Request body too large.' }, { status: 413 });

  let parsedBody: { messages: UIMessage[]; model?: string; temperature?: number; maxOutputTokens?: number };
  try {
    parsedBody = JSON.parse(rawBody) as typeof parsedBody;
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { messages, model: requestedModel, temperature, maxOutputTokens } = parsedBody;
  if (!Array.isArray(messages)) return Response.json({ error: 'messages must be an array.' }, { status: 400 });
  if (messages.length > MAX_MESSAGES) return Response.json({ error: `Too many messages (max ${MAX_MESSAGES}).` }, { status: 400 });
  for (const msg of messages) {
    const parts: unknown = (msg as { content?: unknown }).content;
    if (typeof parts === 'string' && parts.length > MAX_MESSAGE_CHARS) return Response.json({ error: 'Message content too long.' }, { status: 400 });
    if (Array.isArray(parts) && parts.some(isOversizedTextPart)) return Response.json({ error: 'Message content too long.' }, { status: 400 });
  }
  if (requestedModel !== undefined && !MODEL_ID_RE.test(requestedModel)) return Response.json({ error: 'Invalid model ID.' }, { status: 400 });
  if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > MAX_TEMPERATURE)) {
    return Response.json({ error: `temperature must be a number between 0 and ${MAX_TEMPERATURE}.` }, { status: 400 });
  }
  if (maxOutputTokens !== undefined && (typeof maxOutputTokens !== 'number' || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS)) {
    return Response.json({ error: `maxOutputTokens must be between 1 and ${MAX_OUTPUT_TOKENS}.` }, { status: 400 });
  }

  const mcpClient = await connectMcpClient(getMcpBaseUrl()).catch((err: unknown) => {
    console.error('[mcp chat] MCP connection failed:', err instanceof Error ? err.message : err);
    return null;
  });
  if (!mcpClient) return Response.json({ error: 'Failed to connect to the MCP registry server.' }, { status: 502 });

  try {
    const { tools: mcpTools } = await mcpClient.listTools();
    const tools: ToolSet = Object.fromEntries(
      mcpTools.map((t: { name: string; description?: string; inputSchema: unknown }) => [
        t.name,
        {
          description: t.description ?? '',
          inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
          execute: async (args: unknown): Promise<string> => {
            const result = await mcpClient.callTool({ name: t.name, arguments: args as Record<string, unknown> });
            const text = (result.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string)
              .join('\n');
            return text || JSON.stringify(result.content);
          },
        },
      ])
    );

    const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey });
    const result = streamText({
      model: openrouter.chat(requestedModel ?? CHAT_MODEL),
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
