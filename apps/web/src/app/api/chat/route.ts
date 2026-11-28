/**
 * The chat demo, an ordinary client of the registry's MCP server.
 *
 * TJ, 2026-11-27: "the intention of the demo is to be a demo of the MCP, so it should be wired up
 * as the client of the MCP", then "rework 38 so the demo owns its model". So, as Claude or Cursor
 * do, the demo brings its own model (OpenRouter, on this site's own key, OPENROUTER_API_KEY) and
 * reaches the registry only through the MCP endpoint (/api/mcp), listing and calling its tools
 * with the signed-in visitor's own token (lib/chatSignIn.ts). The MCP server holds no chat and pays
 * for no model; its key is for its own embeddings.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { streamText, jsonSchema, convertToModelMessages, stepCountIs } from 'ai';
import type { UIMessage, JSONSchema7, ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checkRateLimit } from '../../../lib/rateLimit';
import { getMcpBaseUrl } from '../../../lib/mcpAuth';
import { CHAT_COOKIE, chatSignInSettings, cookieFrom, currentAccessToken, isConfigured } from '../../../lib/chatSignIn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ── Rate-limit config ─────────────────────────────────────────────────────────
// 20 chat POST requests per minute per address, in this running copy of the site (lib/rateLimit.ts).
const CHAT_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

// ── Payload constraints ───────────────────────────────────────────────────────
const MAX_BODY_BYTES = 100 * 1024; // 100 KB
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 32_768; // 32 KB per individual message content string
const MAX_OUTPUT_TOKENS = 16_384;
// An answer's length when the caller asks for none, so no answer runs to the model's own limit.
const DEFAULT_OUTPUT_TOKENS = 4_096;
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

/** The length of all the text in a message's `parts`, which is where the AI SDK's client sends it. */
function partsTextLength(parts: unknown[]): number {
  let total = 0;
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p['type'] === 'text' && typeof p['text'] === 'string') total += p['text'].length;
  }
  return total;
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

// ── The visitor's own token (lib/chatSignIn.ts) ──────────────────────────────

async function visitorToken(req: Request): Promise<{ access: string; setCookie?: string } | null> {
  const settings = chatSignInSettings();
  if (!isConfigured(settings)) return null;
  return currentAccessToken(settings, cookieFrom(req.headers.get('cookie'), CHAT_COOKIE));
}

const signInRequired = (): Response =>
  Response.json({ error: 'Sign in to chat.', code: 'sign_in_required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });

// ── The registry, through its MCP endpoint, as the visitor ────────────────────

/** Raised when the MCP server refuses the visitor's token: they sign in again. */
class RegistryRefused extends Error {}

async function connectRegistry(mcpUrl: string, access: string): Promise<Client> {
  const client = new Client({ name: 'registry-chat', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${access}` } },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b401\b|unauthorized|invalid_token/i.test(message)) throw new RegistryRefused(message);
    throw err;
  }
  return client;
}

/** The registry's tools, as the model sees them; each call goes back to the MCP server. */
function registryTools(client: Client, listed: Array<{ name: string; description?: string; inputSchema: unknown }>): ToolSet {
  return Object.fromEntries(
    listed.map((t) => [
      t.name,
      {
        description: t.description ?? '',
        inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
        execute: async (args: unknown): Promise<string> => {
          const result = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
          const text = (result.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('\n');
          return text || JSON.stringify(result.content);
        },
      },
    ]),
  );
}

/** Models offered in the picker: the registry's newest tool-capable ones, read from its public list. */
async function fetchAvailableModels(mcpUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${mcpUrl}/api/models?toolsOnly=true&availableOnly=true&sortBy=newest&sortDir=desc&limit=20`);
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

// ── GET – agent config ────────────────────────────────────────────────────────

export async function GET(req: Request): Promise<Response> {
  const defaults = {
    model: CHAT_MODEL,
    systemPrompt: SYSTEM_PROMPT,
    parameters: AGENT_PARAMETERS,
    availableModels: [...FALLBACK_MODELS] as string[],
    tools: [] as Array<{ name: string; description: string }>,
  };
  const mcpUrl = getMcpBaseUrl();
  // Signed out, the page shows the agent's defaults; signed in, the registry's live tools and models.
  const visitor = mcpUrl ? await visitorToken(req) : null;
  if (!mcpUrl || !visitor) return Response.json(defaults);

  const [availableModels, tools] = await Promise.all([
    fetchAvailableModels(mcpUrl),
    (async () => {
      const client = await connectRegistry(mcpUrl, visitor.access).catch(() => null);
      if (!client) return [];
      const listed = await client.listTools().catch(() => ({ tools: [] }));
      await client.close().catch(() => {});
      return listed.tools.map((t: { name: string; description?: string }) => ({ name: t.name, description: t.description ?? '' }));
    })(),
  ]);
  const res = Response.json({ ...defaults, availableModels, tools });
  if (visitor.setCookie) res.headers.append('Set-Cookie', visitor.setCookie);
  return res;
}

// ── POST – the chat ───────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  // ── Rate limiting ───────────────────────────────────────────────────────────
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`chat:${ip}`, CHAT_RATE_LIMIT)) {
    return Response.json({ error: 'Too many requests. Please slow down.' }, { status: 429 });
  }

  const mcpUrl = getMcpBaseUrl();
  if (!mcpUrl) {
    return Response.json({ error: 'MCP_URL is not configured' }, { status: 503 });
  }

  // ── Payload size guard ──────────────────────────────────────────────────────
  const contentLength = Number(req.headers.get('content-length') ?? 0);
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
    parsedBody = JSON.parse(rawBody) as typeof parsedBody;
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
    // Only what the visitor writes: the demo's own earlier answers come back as history, and an
    // answer the visitor asked to be long must not get their next message refused.
    const uiParts: unknown = (msg as { parts?: unknown }).parts;
    const fromVisitor = (msg as { role?: unknown }).role === 'user';
    if (fromVisitor && Array.isArray(uiParts) && partsTextLength(uiParts) > MAX_MESSAGE_CHARS) {
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

  // ── Who is asking, and the demo's own model ────────────────────────────────
  const visitor = await visitorToken(req);
  if (!visitor) return signInRequired();

  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('[chat/route] OPENROUTER_API_KEY is not set on this site');
    return Response.json({ error: 'The chat is not set up yet.' }, { status: 503 });
  }

  let client: Client;
  try {
    client = await connectRegistry(mcpUrl, visitor.access);
  } catch (err) {
    if (err instanceof RegistryRefused) return signInRequired();
    console.error('[chat/route] MCP connection failed:', err instanceof Error ? err.message : err);
    return Response.json({ error: 'Failed to connect to the MCP registry server.' }, { status: 502 });
  }

  try {
    const { tools: listed } = await client.listTools();
    const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey });
    const result = streamText({
      model: openrouter.chat(requestedModel ?? CHAT_MODEL),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      tools: registryTools(client, listed),
      temperature,
      maxOutputTokens: maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
      stopWhen: stepCountIs(AGENT_PARAMETERS.max_steps),
      onFinish: async () => {
        await client.close().catch(() => {});
      },
    });
    const headers = new Headers();
    if (visitor.setCookie) headers.append('Set-Cookie', visitor.setCookie);
    return result.toUIMessageStreamResponse({ headers });
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}
