import { NextRequest, NextResponse } from 'next/server';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
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
      limit: z.number().int().min(1).max(500).optional().default(500),
      offset: z.number().int().min(0).optional().default(0),
      provider: z.string().optional(),
      query: z.string().optional().describe('Text search across model ID, display name, and provider'),
      sortBy: z
        .enum(['id', 'display_name', 'provider', 'context_length', 'input_price_per_1k', 'output_price_per_1k'])
        .optional()
        .default('id')
        .describe('Column to sort results by'),
    },
    async ({ limit, offset, provider, query, sortBy }) => {
      try {
        const models = await getModels({ limit, offset, provider, query, sortBy });
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
    'Search for models by name, ID, or provider substring. Returns matching models sorted by the chosen column.',
    {
      query: z.string().min(1).max(256).describe('Search term to match against model ID, display name, or provider'),
      limit: z.number().int().min(1).max(100).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
      sortBy: z
        .enum(['id', 'display_name', 'provider', 'context_length', 'input_price_per_1k', 'output_price_per_1k'])
        .optional()
        .default('id')
        .describe('Column to sort results by'),
    },
    async ({ query, limit, offset, sortBy }) => {
      try {
        const models = await getModels({ limit, offset, query, sortBy });
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
      sortBy: z
        .enum(['id', 'display_name', 'provider', 'context_length', 'input_price_per_1k', 'output_price_per_1k'])
        .optional()
        .default('id')
        .describe('Column to sort results by'),
    },
    async ({ maxInputPricePer1k, maxOutputPricePer1k, minContextLength, limit, offset, sortBy }) => {
      try {
        const models = await findModelsByCriteria({
          maxInputPricePer1k,
          maxOutputPricePer1k,
          minContextLength,
          limit,
          offset,
          sortBy,
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

  // ── Resources ─────────────────────────────────────────────────────────────

  // Resource: full model list
  server.resource(
    'registry-models',
    'registry://models',
    { description: 'Full list of models currently in the registry', mimeType: 'application/json' },
    async (uri) => {
      try {
        const models = await getModels({ limit: 500, offset: 0 });
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ models, count: models.length }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read registry models: ${message}`);
      }
    }
  );

  // Resource: sync status
  server.resource(
    'registry-status',
    'registry://status',
    { description: 'Current sync status of the model registry (last sync time, record count, errors)', mimeType: 'application/json' },
    async (uri) => {
      try {
        const status = await getSyncStatus();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ status }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read registry status: ${message}`);
      }
    }
  );

  // Resource template: individual model by canonical ID
  server.resource(
    'model',
    new ResourceTemplate('registry://models/{id}', { list: undefined }),
    { description: 'Details for a specific model by its canonical ID (e.g. registry://models/anthropic%2Fclaude-sonnet-4-5)', mimeType: 'application/json' },
    async (uri, { id }) => {
      try {
        const modelId = decodeURIComponent(Array.isArray(id) ? id[0] : id);
        const model = await getModelById(modelId);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ found: model !== null, model }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read model resource: ${message}`);
      }
    }
  );

  // ── Prompts ───────────────────────────────────────────────────────────────

  // Prompt: select_model — guide the model through selecting the best model for a task
  server.prompt(
    'select_model',
    'Generate a structured prompt to help select the best model for a given task, budget, and context requirements.',
    {
      task_description: z.string().describe('Description of the task or use case'),
      budget_usd_per_1k_tokens: z.string().optional().describe('Maximum price in USD per 1,000 tokens (leave blank for no budget limit)'),
      min_context_length: z.string().optional().describe('Minimum required context window in tokens (leave blank for no minimum)'),
    },
    ({ task_description, budget_usd_per_1k_tokens, min_context_length }) => {
      const budgetNote = budget_usd_per_1k_tokens
        ? `Budget constraint: max $${budget_usd_per_1k_tokens} per 1,000 tokens.`
        : 'No budget constraint.';
      const contextNote = min_context_length
        ? `Minimum context window: ${min_context_length} tokens.`
        : 'No minimum context window required.';

      return {
        description: 'Select the best model for a task',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are a model selection assistant with access to the OpenRouter model registry.

Task: ${task_description}
${budgetNote}
${contextNote}

Steps:
1. Use the find_models_by_criteria tool to fetch candidate models that satisfy the budget and context constraints.
2. Use the search_models tool if you need to refine by provider or name.
3. Use the compare_models tool on the top 2–5 candidates.
4. Recommend the best model and explain your reasoning (capability, cost, context fit).`,
            },
          },
        ],
      };
    }
  );

  // Prompt: compare_models_prompt — guide the model through a structured comparison
  server.prompt(
    'compare_models_prompt',
    'Generate a structured prompt to compare a set of models side-by-side on pricing, context length, and capabilities.',
    {
      model_ids: z.string().describe('Comma-separated list of 2–5 canonical model IDs to compare (e.g. "anthropic/claude-sonnet-4-5,openai/gpt-4o")'),
    },
    ({ model_ids }) => {
      const ids = model_ids.split(',').map((s) => s.trim()).filter(Boolean);

      return {
        description: 'Compare models side-by-side',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `You are a model comparison assistant with access to the OpenRouter model registry.

Compare the following models: ${ids.join(', ')}

Steps:
1. Call the compare_models tool with ids: ${JSON.stringify(ids)}.
2. Present a clear side-by-side comparison table covering: display name, provider, context length, input price per 1k tokens, output price per 1k tokens.
3. Highlight the trade-offs between cost and capability.
4. Provide a final recommendation with justification.`,
            },
          },
        ],
      };
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
