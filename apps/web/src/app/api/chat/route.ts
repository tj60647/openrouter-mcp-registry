import type { UIMessage } from 'ai';
import { checkRateLimit } from '../../../lib/rateLimit';
import { getMcpAuthHeaders, getMcpBaseUrl } from '../../../lib/mcpAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Rate-limit config ─────────────────────────────────────────────────────────
// 20 chat POST requests per minute per IP. apps/web only proxies the request;
// apps/mcp owns the OpenRouter call and registry tool execution.
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
  return (
    p['type'] === 'text' && typeof p['text'] === 'string' && p['text'].length > MAX_MESSAGE_CHARS
  );
}

// ── Config ────────────────────────────────────────────────────────────────────

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


const AGENT_PARAMETERS = {
  tool_choice: 'auto',
  max_steps: 10,
  stream: true,
} as const;

const FALLBACK_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3-5-haiku',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
] as const;

// ── MCP proxy helpers ─────────────────────────────────────────────────────────

async function proxyMcpChatConfig(): Promise<Response | null> {
  const mcpUrl = getMcpBaseUrl();
  if (!mcpUrl) return null;

  try {
    const headers = await getMcpAuthHeaders(mcpUrl);
    const res = await fetch(`${mcpUrl}/api/chat`, { headers });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return Response.json(data, { status: res.status });
  } catch {
    return null;
  }
}

// ── GET – agent config ────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  const proxied = await proxyMcpChatConfig();
  if (proxied) return proxied;

  return Response.json({
    model: CHAT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    parameters: AGENT_PARAMETERS,
    availableModels: [...FALLBACK_MODELS],
    tools: [],
  });
}

// ── POST – streaming chat proxy ──────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  // ── Rate limiting ───────────────────────────────────────────────────────────
  const forwarded = (req as { headers: Headers }).headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`chat:${ip}`, CHAT_RATE_LIMIT)) {
    return Response.json({ error: 'Too many requests. Please slow down.' }, { status: 429 });
  }

  const mcpUrl = getMcpBaseUrl();
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

  let parsedBody: {
    messages: UIMessage[];
    model?: string;
    temperature?: number;
    maxOutputTokens?: number;
  };
  try {
    parsedBody = JSON.parse(rawBody) as {
      messages: UIMessage[];
      model?: string;
      temperature?: number;
      maxOutputTokens?: number;
    };
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

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
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' || temperature < 0 || temperature > MAX_TEMPERATURE)
  ) {
    return Response.json(
      { error: `temperature must be a number between 0 and ${MAX_TEMPERATURE}.` },
      { status: 400 }
    );
  }
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== 'number' ||
      maxOutputTokens < 1 ||
      maxOutputTokens > MAX_OUTPUT_TOKENS)
  ) {
    return Response.json(
      { error: `maxOutputTokens must be between 1 and ${MAX_OUTPUT_TOKENS}.` },
      { status: 400 }
    );
  }

  let authHeaders: Record<string, string>;
  try {
    authHeaders = await getMcpAuthHeaders(mcpUrl);
  } catch (err) {
    console.error('[chat/route] MCP auth failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: 'Failed to authenticate with the MCP registry server.' }, { status: 502 });
  }

  const upstream = await fetch(`${mcpUrl}/api/chat`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
      Accept: req.headers.get('accept') ?? '*/*',
    },
    body: JSON.stringify({ messages, model: requestedModel, temperature, maxOutputTokens }),
  }).catch((err: unknown) => {
    console.error('[chat/route] MCP chat proxy failed:', err instanceof Error ? err.message : err);
    return null;
  });

  if (!upstream) {
    return Response.json({ error: 'Failed to connect to the MCP registry server.' }, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
