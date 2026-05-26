import { NextRequest, NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { logger } from '@openrouter-mcp/shared';
import { validateMcpToken } from '../../../lib/auth';
import { checkRateLimit } from '../../../lib/rateLimit';
import { createMcpServer } from '../../../lib/mcpServer';

// 120 MCP requests per minute per IP; intentionally generous because each
// request can encapsulate multiple tool calls.
const MCP_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authError = validateMcpToken(req);
  if (authError) return authError;

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (!checkRateLimit(`mcp:${ip}`, MCP_RATE_LIMIT)) {
    logger.warn('MCP rate limit exceeded', { ip });
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  try {
    const body = await req.text();
    const transport = new WebStandardStreamableHTTPServerTransport({});

    const server = createMcpServer();
    await server.connect(transport);

    const response = await transport.handleRequest(
      new Request(req.url, {
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      })
    );

    return new NextResponse(response.body, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('MCP request failed', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authError = validateMcpToken(req);
  if (authError) return authError;

  return NextResponse.json({
    name: 'openrouter-mcp-registry',
    version: '1.0.0',
    description: 'MCP server for OpenRouter model registry',
    tools: [
      'list_models',
      'resolve_model',
      'get_model',
      'search_models',
      'find_models_by_criteria',
      'compare_models',
      'semantic_search',
      'get_registry_status',
      'get_sync_history',
    ],
    resources: [
      'registry://models',
      'registry://status',
      'registry://models/{id}',
    ],
    prompts: [
      'select_model',
      'compare_models_prompt',
    ],
    transport: 'streamable-http',
    endpoint: '/api/mcp',
  });
}
