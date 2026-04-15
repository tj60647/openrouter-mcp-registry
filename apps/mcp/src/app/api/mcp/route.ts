import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  ModelRegistry,
  InMemoryAliasService,
  SYSTEM_ALIASES,
  logger,
} from '@openrouter-mcp/shared';
import {
  getModels,
  getModelById,
  getSyncStatus,
  resolveAlias,
} from '../../../lib/db';
import { validateMcpToken } from '../../../lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'openrouter-mcp-registry',
    version: '1.0.0',
  });

  // Tool: list_models
  server.tool(
    'list_models',
    'List all available models in the registry',
    {
      limit: z.number().int().min(1).max(500).optional().default(100),
      offset: z.number().int().min(0).optional().default(0),
      provider: z.string().optional(),
    },
    async ({ limit, offset, provider }) => {
      try {
        const models = await getModels({ limit, offset, provider });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ models, count: models.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool: resolve_model
  server.tool(
    'resolve_model',
    'Resolve a model alias or ID to its canonical form',
    {
      input: z.string().min(1).max(256),
    },
    async ({ input }) => {
      try {
        const dbAlias = await resolveAlias(input);
        const dbAliases = dbAlias ? { [input]: dbAlias } : {};
        const combinedAliases = { ...SYSTEM_ALIASES, ...dbAliases };

        const aliasService = new InMemoryAliasService(combinedAliases);
        const registry = new ModelRegistry({ findById: getModelById }, aliasService);
        const result = await registry.resolve(input);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  input,
                  resolved: result.resolved,
                  source: result.source,
                  found: result.model !== null,
                  model: result.model,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool: get_default_model
  server.tool(
    'get_default_model',
    'Get the default model (resolves the "best-general" alias)',
    {},
    async () => {
      try {
        const aliasService = new InMemoryAliasService(SYSTEM_ALIASES);
        const registry = new ModelRegistry({ findById: getModelById }, aliasService);
        const result = await registry.resolve('best-general');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  resolved: result.resolved,
                  source: result.source,
                  model: result.model,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool: get_sync_status
  server.tool(
    'get_sync_status',
    'Get the current sync status of the model registry',
    {},
    async () => {
      try {
        const status = await getSyncStatus();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );

  return server;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authError = validateMcpToken(req);
  if (authError) return authError;

  try {
    const body = await req.text();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

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
    tools: ['list_models', 'resolve_model', 'get_default_model', 'get_sync_status'],
    transport: 'streamable-http',
    endpoint: '/api/mcp',
  });
}
