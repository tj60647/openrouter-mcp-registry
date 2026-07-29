import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ModelRegistry } from '@openrouter-mcp/shared';
import type { Model } from '@openrouter-mcp/shared';
import {
  getModels,
  getModelsCount,
  getModelCounts,
  getModelById,
  getSyncStatus,
  getSyncHistory,
  findModelsByCriteria,
  findModelsByCriteriaCount,
  semanticSearchModels,
} from './db';
import { generateEmbedding } from './embeddings';
import { recordUsage } from './oauthStore';
import { checkRateLimit } from './rateLimit';

/** Fields dropped from list-style responses unless `verbose` is set — they dominate payload size. */
const VERBOSE_ONLY_FIELDS = ['description', 'metadata'] as const;

/**
 * Trims model records returned by the list-style tools so a single page does
 * not blow up the caller's context window.
 *
 * - `fields` (when non-empty) wins: only those fields are returned, in the
 *   order given, with `id` always present. Unknown names are ignored.
 * - Otherwise `verbose: true` returns the full record and `verbose: false`
 *   (the default) drops `description` and `metadata`.
 *
 * `get_model`, `resolve_model`, `compare_models` and the `registry://`
 * resources deliberately do NOT use this — they always return full records.
 */
function projectModels(models: Model[], opts: { verbose: boolean; fields?: string[] }): unknown[] {
  const { verbose, fields } = opts;

  if (fields && fields.length > 0) {
    return models.map((model) => {
      const source = model as unknown as Record<string, unknown>;
      const picked: Record<string, unknown> = { id: model.id };
      for (const field of fields) {
        if (field !== 'id' && field in source) picked[field] = source[field];
      }
      return picked;
    });
  }

  if (verbose) return models;

  return models.map((model) => {
    const trimmed: Record<string, unknown> = { ...model };
    for (const field of VERBOSE_ONLY_FIELDS) delete trimmed[field];
    return trimmed;
  });
}

// ── Shared tool argument schemas ─────────────────────────────────────────────
// Built by factories so each tool gets its own schema instance and therefore a
// self-contained JSON schema, without duplicating the definitions.

/** Sort columns accepted by the list-style tools, in snake_case and camelCase. */
const SORT_BY_VALUES = [
  'id', 'display_name', 'provider',
  'context_length', 'max_completion_tokens',
  'input_price_per_1k', 'output_price_per_1k', 'image_price_per_1k',
  'created_at',
  // camelCase spellings of exactly the same columns
  'displayName', 'contextLength', 'maxCompletionTokens',
  'inputPricePer1k', 'outputPricePer1k', 'imagePricePer1k', 'createdAt',
] as const;

function sortByArg() {
  return z
    .enum(SORT_BY_VALUES)
    .optional()
    .default('id')
    .describe(
      'Column to sort results by. Both snake_case and camelCase spellings are accepted and mean the same thing (e.g. created_at or createdAt, input_price_per_1k or inputPricePer1k).'
    );
}

function sortDirArg() {
  return z
    .enum(['asc', 'desc'])
    .optional()
    .default('asc')
    .describe('Sort direction. Use desc with created_at for newest-first results.');
}

function verboseArg() {
  return z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Set true to include description and metadata. Default false omits both from every returned record to keep the payload small.'
    );
}

function fieldsArg() {
  return z
    .array(z.string())
    .optional()
    .describe(
      'Explicit projection: camelCase Model field names to return (e.g. ["displayName","contextLength","inputPricePer1k"]). Takes precedence over verbose. "id" is always included and unknown field names are ignored.'
    );
}

/**
 * Per-client budgets for the tool path.
 *
 * Dynamic client registration is deliberately open (the catalogue is public,
 * read-only data and interactive MCP clients bootstrap through it), and the
 * limiters on /api/oauth/* throttle *acquiring* a token. Nothing throttled
 * *using* one, so a self-registered client could call tools without bound.
 *
 * The general budget is deliberately generous — this is a read-only registry
 * and a legitimate agent may page through the catalogue. semantic_search gets a
 * tighter one because it is the only tool that makes a paid outbound call,
 * embedding the query on every invocation.
 */
const TOOL_RATE_LIMIT = { limit: 600, windowMs: 60_000 };
const SEMANTIC_SEARCH_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

/** Tools whose cost is not bounded by the registry alone. */
const PAID_TOOLS = new Set(['semantic_search']);

/**
 * Wrap `server.tool` so every tool call is (a) charged against the calling
 * OAuth client's budget and (b) recorded as a usage row attributed to that
 * client (both from the request's authInfo). Usage logging is best-effort: a
 * failed write never affects the tool response. Applied before any tool is
 * registered so all registrations are instrumented.
 */
function instrumentUsage(server: McpServer): void {
  const original = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const name = args[0] as string;
    const lastIdx = args.length - 1;
    const handler = args[lastIdx];
    if (typeof handler === 'function') {
      const inner = handler as (a: unknown, extra: unknown) => Promise<{ isError?: boolean }>;
      args[lastIdx] = async (a: unknown, extra: unknown) => {
        const clientId =
          (extra as { authInfo?: { clientId?: string } } | undefined)?.authInfo?.clientId ?? 'unknown';
        let ok = true;
        try {
          const paid = PAID_TOOLS.has(name);
          const allowed = await checkRateLimit(
            paid ? `mcp:tool:${name}:${clientId}` : `mcp:tool:${clientId}`,
            paid ? SEMANTIC_SEARCH_RATE_LIMIT : TOOL_RATE_LIMIT
          );
          if (!allowed) {
            ok = false;
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: rate limit exceeded for ${name}. Retry in under a minute.`,
                },
              ],
              isError: true,
            };
          }

          const result = await inner(a, extra);
          ok = !result?.isError;
          return result;
        } catch (err) {
          ok = false;
          throw err;
        } finally {
          try {
            await recordUsage(clientId, name, ok);
          } catch {
            /* best-effort usage logging — never fail the tool call */
          }
        }
      };
    }
    return original(...args);
  };
}

/** Registers all tools, resources, and prompts on a server instance. */
export async function initMcpServer(server: McpServer): Promise<void> {
  instrumentUsage(server);

  // Tool: list_models
  server.tool(
    'list_models',
    'List available models in the registry with optional filtering. Use the query param to search by name, ID, or provider. The response reports both count (records in this page) and total (records matching the filter, ignoring limit/offset).',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Maximum records to return in one page. OMIT IT to return every matching record — that is the default. Payload size is controlled by verbose/fields, not by limit. Supply it only when you deliberately want a page, in which case pair it with offset.'
        ),
      offset: z.number().int().min(0).optional().default(0),
      provider: z.string().optional(),
      query: z.string().optional().describe('Text search across model ID, display name, and provider'),
      sortBy: sortByArg(),
      sortDir: sortDirArg(),
      availableOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'When true, exclude retired models (is_available = false). Default false: retired models ARE included, which is why list_models can return more records than get_registry_status.recordCount.'
        ),
      verbose: verboseArg(),
      fields: fieldsArg(),
    },
    async ({ limit, offset, provider, query, sortBy, sortDir, availableOnly, verbose, fields }) => {
      try {
        const [models, total] = await Promise.all([
          getModels({ limit, offset, provider, query, sortBy, sortDir, availableOnly }),
          getModelsCount({ provider, query, availableOnly }),
        ]);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { models: projectModels(models, { verbose, fields }), count: models.length, total },
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
    'Search for models by name, ID, or provider substring. Returns matching models sorted by the chosen column. The response reports both count (records in this page) and total (records matching the search, ignoring limit/offset).',
    {
      query: z.string().min(1).max(256).describe('Search term to match against model ID, display name, or provider'),
      limit: z.number().int().min(1).max(100).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
      sortBy: sortByArg(),
      sortDir: sortDirArg(),
      verbose: verboseArg(),
      fields: fieldsArg(),
    },
    async ({ query, limit, offset, sortBy, sortDir, verbose, fields }) => {
      try {
        const [models, total] = await Promise.all([
          getModels({ limit, offset, query, sortBy, sortDir }),
          getModelsCount({ query }),
        ]);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { models: projectModels(models, { verbose, fields }), count: models.length, total },
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

  // Tool: find_models_by_criteria
  server.tool(
    'find_models_by_criteria',
    'Filter models by budget, context, and capability constraints. All parameters are optional — omit any you don\'t care about. Models with NULL prices are always included (treated as free/unknown). The response reports both count (records in this page) and total (records matching the filter, ignoring limit/offset).',
    {
      maxInputPricePer1k: z
        .number()
        .nonnegative()
        .optional()
        .describe('Maximum input price, in USD per 1,000 tokens. Registry prices are always USD per 1,000 tokens.'),
      maxOutputPricePer1k: z
        .number()
        .nonnegative()
        .optional()
        .describe('Maximum output price, in USD per 1,000 tokens. Registry prices are always USD per 1,000 tokens.'),
      minContextLength: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Minimum context window size in tokens'),
      modality: z
        .string()
        .optional()
        .describe(
          'Filter by modality, which OpenRouter writes as "inputs->outputs" with "+"-separated modalities on each side (e.g. "text->text", "text+image->text", "text+image+file->text", "text->image"). Matching is a case-insensitive SUBSTRING match over the WHOLE string, including the "->". To find vision models you must match the LEFT (input) side — use "image->" (or "text+image->text"); "text->image" is an image GENERATOR, not a vision model.'
        ),
      limit: z.number().int().min(1).max(200).optional().default(50),
      offset: z.number().int().min(0).optional().default(0),
      sortBy: sortByArg(),
      sortDir: sortDirArg(),
      verbose: verboseArg(),
      fields: fieldsArg(),
    },
    async ({ maxInputPricePer1k, maxOutputPricePer1k, minContextLength, modality, limit, offset, sortBy, sortDir, verbose, fields }) => {
      try {
        const criteria = { maxInputPricePer1k, maxOutputPricePer1k, minContextLength, modality };
        const [models, total] = await Promise.all([
          findModelsByCriteria({ ...criteria, limit, offset, sortBy, sortDir }),
          findModelsByCriteriaCount(criteria),
        ]);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { models: projectModels(models, { verbose, fields }), count: models.length, total },
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
          description: model?.description ?? null,
          modality: model?.modality ?? null,
          contextLength: model?.contextLength ?? null,
          maxCompletionTokens: model?.maxCompletionTokens ?? null,
          inputPricePer1k: model?.inputPricePer1k ?? null,
          outputPricePer1k: model?.outputPricePer1k ?? null,
          imagePricePer1k: model?.imagePricePer1k ?? null,
          createdAt: model?.createdAt ?? null,
          providerExpirationAt: model?.providerExpirationAt ?? null,
          lastSeenAt: model?.lastSeenAt ?? null,
          retiredAt: model?.retiredAt ?? null,
          isAvailable: model?.isAvailable ?? null,
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

  // Tool: semantic_search
  server.tool(
    'semantic_search',
    'Find models by semantic similarity to a natural language description. Describe what you need (e.g. "fast cheap summarization model", "multimodal vision model for images") and get the most relevant matches. Uses OPENROUTER_API_KEY to generate embeddings via openai/text-embedding-3-small on OpenRouter.',
    {
      query: z
        .string()
        .min(1)
        .max(1000)
        .describe('Natural language description of the kind of model you are looking for'),
      limit: z.number().int().min(1).max(50).optional().default(10),
      offset: z.number().int().min(0).optional().default(0),
      verbose: verboseArg(),
      fields: fieldsArg(),
    },
    async ({ query, limit, offset, verbose, fields }) => {
      try {
        const openrouterKey = process.env['OPENROUTER_API_KEY'];
        if (!openrouterKey) {
          return {
            content: [
              {
                type: 'text',
                text: 'Semantic search is unavailable: OPENROUTER_API_KEY is not configured on this server.',
              },
            ],
            isError: true,
          };
        }
        const embedding = await generateEmbedding(query, openrouterKey);
        const models = await semanticSearchModels({ embedding, limit, offset });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { models: projectModels(models, { verbose, fields }), count: models.length },
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

  // Tool: get_registry_status
  server.tool(
    'get_registry_status',
    'Get the current sync status of the model registry (last sync time, record counts, any errors). recordCount is the number of models in the last SUCCESSFUL sync, so it excludes retired models; totalCount is the live number of rows in the registry and therefore includes retired models. totalCount = availableCount + retiredCount, and list_models with the default availableOnly=false can return up to totalCount records.',
    {},
    async () => {
      try {
        const [status, counts] = await Promise.all([getSyncStatus(), getModelCounts()]);
        // Live counts are folded into the status object so callers can
        // reconcile them against recordCount. status stays null when no sync
        // has ever been recorded.
        const payload = status
          ? {
              ...status,
              totalCount: counts.total,
              availableCount: counts.available,
              retiredCount: counts.retired,
            }
          : null;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: payload }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    }
  );

  // Tool: get_sync_history
  server.tool(
    'get_sync_history',
    'Get the history of sync attempts (most recent first). One row per attempt. status is "running" (started, not yet finished — success is null), "success", or "failure"; a failure always carries an error message. syncedAt is when the attempt started and finishedAt when it ended (null while running). A "running" row older than the newest finished row is an attempt whose process died mid-sync.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe('Maximum number of history entries to return'),
    },
    async ({ limit }) => {
      try {
        const history = await getSyncHistory(limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ history, count: history.length }, null, 2),
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
        // No limit: this resource is documented as the full registry, so a cap
        // here would silently truncate it once the catalogue outgrew the number.
        const models = await getModels({ offset: 0 });
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

}
