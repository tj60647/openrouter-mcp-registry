import { NextRequest, NextResponse } from 'next/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  ModelRegistry,
  logger,
} from '@openrouter-mcp/shared';
import {
  getModels,
  getModelById,
  getSyncStatus,
  findModelsByCriteria,
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
    'List available models in the registry with optional filtering. Use the query param to search by name, ID, or provider.',
    {
      limit: z.number().int().min(1).max(500).optional().default(100),
      offset: z.number().int().min(0).optional().default(0),
      provider: z.string().optional(),
      query: z.string().optional().describe('Text search across model ID, display name, and provider'),
    },
    async ({ limit, offset, provider, query }) => {
      try {
        const models = await getModels({ limit, offset, provider, query });
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
    'Resolve a model ID to its canonical form and fetch its details',
    {
      input: z.string().min(1).max(256),
    },
    async ({ input }) => {
      try {
        const registry = new ModelRegistry({ findById: getModelById });
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

  // Tool: get_model
  server.tool(
    'get_model',
    'Get full details for a single model by its canonical ID (e.g. "anthropic/claude-sonnet-4-5")',
    {
      id: z.string().min(1).max(256).describe('Canonical model ID'),
    },
    async ({ id }) => {
      try {
        const model = await getModelById(id);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ found: model !== null, model }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool: search_models
  server.tool(
    'search_models',
    'Search for models by name, ID, or provider substring. Returns matching models sorted by ID.',
    {
      query: z.string().min(1).max(256).describe('Search term to match against model ID, display name, or provider'),
      limit: z.number().int().min(1).max(100).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
    },
    async ({ query, limit, offset }) => {
      try {
        const models = await getModels({ limit, offset, query });
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

  // Tool: find_models_by_criteria
  server.tool(
    'find_models_by_criteria',
    'Filter models by budget and context constraints. All parameters are optional — omit any you don\'t care about. Models with NULL prices are always included (treated as free/unknown).',
    {
      maxInputPricePer1k: z
        .number()
        .nonnegative()
        .optional()
        .describe('Maximum input price per 1,000 tokens (USD)'),
      maxOutputPricePer1k: z
        .number()
        .nonnegative()
        .optional()
        .describe('Maximum output price per 1,000 tokens (USD)'),
      minContextLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Minimum context window size in tokens'),
      limit: z.number().int().min(1).max(200).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
    },
    async ({ maxInputPricePer1k, maxOutputPricePer1k, minContextLength, limit, offset }) => {
      try {
        const models = await findModelsByCriteria({
          maxInputPricePer1k,
          maxOutputPricePer1k,
          minContextLength,
          limit,
          offset,
        });
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

  // Tool: compare_models
  server.tool(
    'compare_models',
    'Compare 2–5 models side-by-side on pricing, context length, and metadata. Pass canonical model IDs.',
    {
      ids: z
        .array(z.string().min(1).max(256))
        .min(2)
        .max(5)
        .describe('Array of 2–5 canonical model IDs to compare'),
    },
    async ({ ids }) => {
      try {
        const results = await Promise.all(
          ids.map(async (id) => {
            const model = await getModelById(id);
            return { id, found: model !== null, model };
          })
        );

        // Build a condensed comparison table
        const comparison = results.map(({ id, found, model }) => ({
          id,
          found,
          displayName: model?.displayName ?? null,
          provider: model?.provider ?? null,
          contextLength: model?.contextLength ?? null,
          inputPricePer1k: model?.inputPricePer1k ?? null,
          outputPricePer1k: model?.outputPricePer1k ?? null,
          metadata: model?.metadata ?? null,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ comparison }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool: get_registry_status
  server.tool(
    'get_registry_status',
    'Get the current sync status of the model registry (last sync time, record count, any errors)',
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
      'get_registry_status',
    ],
    transport: 'streamable-http',
    endpoint: '/api/mcp',
  });
}
