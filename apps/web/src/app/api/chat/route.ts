import { checkRateLimit } from '../../../lib/rateLimit';
import { buildMcpHeaders, getConfiguredMcpUrl } from '../../../lib/mcpProxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHAT_RATE_LIMIT = { limit: 20, windowMs: 60_000 };
const MAX_BODY_BYTES = 100 * 1024;

async function proxyToMcpChat(
  req: Request,
  method: 'GET' | 'POST',
  body?: string
): Promise<Response> {
  const mcpUrl = getConfiguredMcpUrl();
  if (!mcpUrl) {
    return Response.json({ error: 'MCP_URL is not configured' }, { status: 503 });
  }

  let headers: HeadersInit;
  try {
    headers = await buildMcpHeaders(mcpUrl, 'mcp:read');
  } catch (err) {
    console.error('[chat/route] MCP auth failed:', err instanceof Error ? err.message : err);
    return Response.json(
      { error: 'Failed to authenticate to the MCP registry server.' },
      { status: 502 }
    );
  }

  const forwardedFor = req.headers.get('x-forwarded-for');
  const res = await fetch(`${mcpUrl}/api/chat`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    body,
  });

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export async function GET(req: Request): Promise<Response> {
  return proxyToMcpChat(req, 'GET');
}

export async function POST(req: Request): Promise<Response> {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`chat:${ip}`, CHAT_RATE_LIMIT)) {
    return Response.json({ error: 'Too many requests. Please slow down.' }, { status: 429 });
  }

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

  return proxyToMcpChat(req, 'POST', rawBody);
}
