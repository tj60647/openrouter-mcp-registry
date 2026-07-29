/**
 * @file mcp-tools.test.ts
 * Unit tests for the MCP server tool handlers defined in apps/mcp.
 * The MCP SDK and all db/embedding dependencies are mocked so no network
 * or database connections are required.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import type { Model, SyncStatus, SyncHistoryEntry } from '@openrouter-mcp/shared';

// ── Hoisted shared state (captured tool handlers) ─────────────────────────────
// vi.hoisted runs before module-level code, so the factory can reference this
// variable safely even though vi.mock calls are hoisted above imports.

// `extra` carries the request's authInfo, which the usage/rate-limit wrapper
// reads to attribute a call to an OAuth client.
const toolHandlers = vi.hoisted(
  () =>
    ({} as Record<
      string,
      (args: Record<string, unknown>, extra?: { authInfo?: { clientId?: string } }) => Promise<ToolResult>
    >)
);

type ContentItem = { type: string; text: string };
type ToolResult = { content: ContentItem[]; isError?: boolean };

/**
 * Zod input schemas, captured per tool.
 *
 * The mock used to bind the schema argument to `_schema` and drop it, so zod
 * never executed in any test: every carefully bounded `.min()`, `.max()`,
 * `.enum()` and `.default()` was untested, and handlers were invoked with raw
 * unvalidated objects. Capturing it lets tests parse input the way the wire
 * protocol does.
 */
const toolSchemas = vi.hoisted(() => ({}) as Record<string, Record<string, ZodTypeAny>>);

// ── Mock the MCP SDK ──────────────────────────────────────────────────────────
// The real call is the 4-arg overload server.tool(name, description,
// paramsSchema, handler), where paramsSchema is a ZodRawShape -- a plain object
// of zod schemas, not a z.object() and not JSON Schema. instrumentUsage
// rewraps the LAST argument before this sees it, so args[2] is still the schema.

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn((...args: unknown[]) => {
      const name = args[0] as string;
      const handler = args[args.length - 1];
      const schema = args.length > 3 ? args[2] : undefined;
      if (typeof handler === 'function') {
        toolHandlers[name] = handler as (typeof toolHandlers)[string];
      }
      if (schema && typeof schema === 'object') {
        toolSchemas[name] = schema as Record<string, ZodTypeAny>;
      }
    }),
    resource: vi.fn(),
    prompt: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
  ResourceTemplate: vi.fn().mockImplementation((template: string) => ({ template })),
}));

/** Parse tool input exactly as the MCP server would before calling a handler. */
function parseToolInput(tool: string, input: unknown) {
  const shape = toolSchemas[tool];
  if (!shape) throw new Error(`no schema captured for tool "${tool}"`);
  return z.object(shape).safeParse(input);
}

// ── Mock db module ────────────────────────────────────────────────────────────

const mockGetModels = vi.fn<[], Promise<Model[]>>();
const mockGetModelById = vi.fn<[string], Promise<Model | null>>();
const mockGetSyncStatus = vi.fn<[], Promise<SyncStatus | null>>();
const mockGetSyncHistory = vi.fn<[number?], Promise<SyncHistoryEntry[]>>();
const mockFindModelsByCriteria = vi.fn<[], Promise<Model[]>>();
const mockSemanticSearchModels = vi.fn<[], Promise<Model[]>>();
// Count helpers resolve to a harmless default so tests that only care about
// the model payload do not have to stub them.
const mockGetModelsCount = vi.fn<[], Promise<number>>().mockResolvedValue(0);
const mockFindModelsByCriteriaCount = vi.fn<[], Promise<number>>().mockResolvedValue(0);
const mockGetModelCounts = vi
  .fn<[], Promise<{ total: number; available: number; retired: number }>>()
  .mockResolvedValue({ total: 0, available: 0, retired: 0 });

vi.mock('../lib/db', () => ({
  getModels: (...args: unknown[]) => mockGetModels(...(args as [])),
  getModelsCount: (...args: unknown[]) => mockGetModelsCount(...(args as [])),
  getModelCounts: (...args: unknown[]) => mockGetModelCounts(...(args as [])),
  getModelById: (...args: unknown[]) => mockGetModelById(...(args as [string])),
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...(args as [])),
  getSyncHistory: (...args: unknown[]) => mockGetSyncHistory(...(args as [number?])),
  findModelsByCriteria: (...args: unknown[]) => mockFindModelsByCriteria(...(args as [])),
  findModelsByCriteriaCount: (...args: unknown[]) => mockFindModelsByCriteriaCount(...(args as [])),
  semanticSearchModels: (...args: unknown[]) => mockSemanticSearchModels(...(args as [])),
}));

// ── Mock embeddings module ────────────────────────────────────────────────────

const mockGenerateEmbedding = vi.fn<[], Promise<number[]>>();

vi.mock('../lib/embeddings', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...(args as [])),
}));

// ── Mock oauthStore (usage instrumentation) ──────────────────────────────────
// initMcpServer wraps every tool to record usage; stub it so tool tests don't
// touch the database.

vi.mock('../lib/oauthStore', () => ({
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock the rate limiter ─────────────────────────────────────────────────────
// initMcpServer charges every tool call against the calling client's budget.
// The limiter is Postgres-backed and this suite does not mock @vercel/postgres,
// so leaving it real would fail closed and deny every call. Its own behaviour is
// covered in rateLimit.test.ts.

const mockCheckRateLimit = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../lib/rateLimit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...(args as [])),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'test/model',
    provider: 'test',
    displayName: 'Test Model',
    description: null,
    modality: 'text->text',
    contextLength: 4096,
    maxCompletionTokens: null,
    inputPricePer1k: 0.001,
    outputPricePer1k: 0.002,
    imagePricePer1k: null,
    createdAt: new Date('2024-01-01'),
    providerExpirationAt: null,
    supportedParameters: [],
    metadata: {},
    fetchedAt: new Date('2024-01-01'),
    lastSeenAt: new Date('2024-01-01'),
    retiredAt: null,
    isAvailable: true,
    ...overrides,
  };
}

function makeSyncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    lastSuccessfulSync: new Date('2024-06-01T12:00:00Z'),
    lastAttemptedSync: new Date('2024-06-01T12:00:00Z'),
    lastError: null,
    recordCount: 42,
    ...overrides,
  };
}

function makeSyncHistoryEntry(overrides: Partial<SyncHistoryEntry> = {}): SyncHistoryEntry {
  return {
    id: 1,
    syncedAt: new Date('2024-06-01T12:00:00Z'),
    status: 'success',
    success: true,
    recordCount: 42,
    error: null,
    finishedAt: new Date('2024-06-01T12:00:02Z'),
    ...overrides,
  };
}

/** Parse the JSON payload from the first content item of a tool result. */
function parseResult(result: ToolResult): unknown {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text);
}

// ── Populate tool handlers by importing and calling initMcpServer ─────────────

beforeAll(async () => {
  const { initMcpServer } = await import('../lib/mcp-server');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  await initMcpServer(server);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('list_models tool', () => {
  it('returns models and count as JSON', async () => {
    const models = [makeModel({ id: 'a/b' }), makeModel({ id: 'c/d' })];
    mockGetModels.mockResolvedValueOnce(models);

    const result = await toolHandlers['list_models']!({
      limit: 10,
      offset: 0,
      availableOnly: false,
      sortBy: 'id',
      sortDir: 'asc',
    });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { models: unknown[]; count: number };
    expect(body.count).toBe(2);
    expect(body.models).toHaveLength(2);
  });

  it('returns total (matching rows) alongside count (page size)', async () => {
    mockGetModels.mockResolvedValueOnce([makeModel({ id: 'a/b' })]);
    mockGetModelsCount.mockResolvedValueOnce(137);

    const result = await toolHandlers['list_models']!({ limit: 1, offset: 0 });

    const body = parseResult(result) as { count: number; total: number };
    expect(body.count).toBe(1);
    expect(body.total).toBe(137);
  });

  it('passes the availability filter to the count query too', async () => {
    mockGetModels.mockResolvedValueOnce([]);
    mockGetModelsCount.mockResolvedValueOnce(0);

    await toolHandlers['list_models']!({ limit: 10, offset: 0, provider: 'anthropic', availableOnly: true });

    expect(mockGetModelsCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'anthropic', availableOnly: true })
    );
  });

  it('leaves limit undefined when the caller omits it, so the db returns everything', async () => {
    mockGetModels.mockResolvedValueOnce([makeModel()]);
    mockGetModelsCount.mockResolvedValueOnce(1);

    await toolHandlers['list_models']!({ offset: 0 });

    expect(mockGetModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: undefined, offset: 0 })
    );
  });

  it('reports count === total for an unbounded pull', async () => {
    mockGetModels.mockResolvedValueOnce([makeModel({ id: 'a/one' }), makeModel({ id: 'b/two' })]);
    mockGetModelsCount.mockResolvedValueOnce(2);

    const result = await toolHandlers['list_models']!({ offset: 0 });

    const body = parseResult(result) as { count: number; total: number };
    expect(body.count).toBe(2);
    expect(body.total).toBe(2);
  });

  it('returns isError: true when the db throws', async () => {
    mockGetModels.mockRejectedValueOnce(new Error('db down'));
    const result = await toolHandlers['list_models']!({ limit: 10, offset: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('db down');
  });
});

describe('get_model tool', () => {
  it('returns found: true and model data when the model exists', async () => {
    const model = makeModel({ id: 'anthropic/claude-3' });
    mockGetModelById.mockResolvedValueOnce(model);

    const result = await toolHandlers['get_model']!({ id: 'anthropic/claude-3' });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { found: boolean; model: Model };
    expect(body.found).toBe(true);
    expect(body.model.id).toBe('anthropic/claude-3');
  });

  it('returns found: false when the model does not exist', async () => {
    mockGetModelById.mockResolvedValueOnce(null);
    const result = await toolHandlers['get_model']!({ id: 'nobody/nope' });
    const body = parseResult(result) as { found: boolean; model: null };
    expect(body.found).toBe(false);
    expect(body.model).toBeNull();
  });

  it('returns isError: true on db error', async () => {
    mockGetModelById.mockRejectedValueOnce(new Error('connection lost'));
    const result = await toolHandlers['get_model']!({ id: 'x/y' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('connection lost');
  });
});

describe('resolve_model tool', () => {
  it('returns found: true for an exact model ID match', async () => {
    const model = makeModel({ id: 'openai/gpt-4o' });
    mockGetModelById.mockResolvedValue(model);

    const result = await toolHandlers['resolve_model']!({ input: 'openai/gpt-4o' });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { found: boolean; resolved: string };
    expect(body.found).toBe(true);
    expect(body.resolved).toBe('openai/gpt-4o');
  });

  it('returns found: false when the model cannot be resolved', async () => {
    mockGetModelById.mockResolvedValue(null);
    const result = await toolHandlers['resolve_model']!({ input: 'does-not-exist' });
    const body = parseResult(result) as { found: boolean };
    expect(body.found).toBe(false);
  });

  it('returns isError: true on db error', async () => {
    mockGetModelById.mockRejectedValue(new Error('timeout'));
    const result = await toolHandlers['resolve_model']!({ input: 'some/model' });
    expect(result.isError).toBe(true);
  });
});

describe('search_models tool', () => {
  it('returns matching models', async () => {
    const models = [makeModel({ displayName: 'Claude Sonnet' })];
    mockGetModels.mockResolvedValueOnce(models);

    const result = await toolHandlers['search_models']!({
      query: 'claude',
      limit: 20,
      offset: 0,
      sortBy: 'id',
      sortDir: 'asc',
    });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { models: unknown[]; count: number };
    expect(body.count).toBe(1);
  });

  it('returns total (matching rows) alongside count (page size)', async () => {
    mockGetModels.mockResolvedValueOnce([makeModel()]);
    mockGetModelsCount.mockResolvedValueOnce(9);

    const result = await toolHandlers['search_models']!({ query: 'claude', limit: 20, offset: 0 });

    const body = parseResult(result) as { count: number; total: number };
    expect(body.count).toBe(1);
    expect(body.total).toBe(9);
    expect(mockGetModelsCount).toHaveBeenLastCalledWith({ query: 'claude' });
  });

  it('returns isError: true on db error', async () => {
    mockGetModels.mockRejectedValueOnce(new Error('query failed'));
    const result = await toolHandlers['search_models']!({ query: 'test', limit: 10, offset: 0 });
    expect(result.isError).toBe(true);
  });
});

describe('find_models_by_criteria tool', () => {
  it('returns filtered models', async () => {
    const models = [makeModel({ inputPricePer1k: 0.0001 })];
    mockFindModelsByCriteria.mockResolvedValueOnce(models);

    const result = await toolHandlers['find_models_by_criteria']!({
      maxInputPricePer1k: 0.01,
      limit: 50,
      offset: 0,
      sortBy: 'id',
      sortDir: 'asc',
    });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { models: unknown[]; count: number };
    expect(body.count).toBe(1);
  });

  it('returns empty models list when no criteria match', async () => {
    mockFindModelsByCriteria.mockResolvedValueOnce([]);
    const result = await toolHandlers['find_models_by_criteria']!({ limit: 50, offset: 0 });
    const body = parseResult(result) as { count: number };
    expect(body.count).toBe(0);
  });

  it('returns total from the criteria count query, built from the same criteria', async () => {
    mockFindModelsByCriteria.mockResolvedValueOnce([makeModel()]);
    mockFindModelsByCriteriaCount.mockResolvedValueOnce(23);

    const result = await toolHandlers['find_models_by_criteria']!({
      maxInputPricePer1k: 0.01,
      modality: 'image->',
      limit: 50,
      offset: 0,
    });

    const body = parseResult(result) as { count: number; total: number };
    expect(body.count).toBe(1);
    expect(body.total).toBe(23);
    expect(mockFindModelsByCriteriaCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxInputPricePer1k: 0.01, modality: 'image->' })
    );
  });

  it('returns isError: true on db error', async () => {
    mockFindModelsByCriteria.mockRejectedValueOnce(new Error('bad query'));
    const result = await toolHandlers['find_models_by_criteria']!({ limit: 50, offset: 0 });
    expect(result.isError).toBe(true);
  });
});

describe('compare_models tool', () => {
  it('returns a comparison entry for each requested ID', async () => {
    const m1 = makeModel({ id: 'a/model-1', displayName: 'Model One' });
    const m2 = makeModel({ id: 'b/model-2', displayName: 'Model Two' });
    mockGetModelById
      .mockResolvedValueOnce(m1)
      .mockResolvedValueOnce(m2);

    const result = await toolHandlers['compare_models']!({ ids: ['a/model-1', 'b/model-2'] });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { comparison: { id: string; found: boolean }[] };
    expect(body.comparison).toHaveLength(2);
    expect(body.comparison[0]?.id).toBe('a/model-1');
    expect(body.comparison[0]?.found).toBe(true);
    expect(body.comparison[1]?.id).toBe('b/model-2');
  });

  it('marks an ID as found: false when the model is missing', async () => {
    mockGetModelById
      .mockResolvedValueOnce(makeModel({ id: 'real/model' }))
      .mockResolvedValueOnce(null);

    const result = await toolHandlers['compare_models']!({
      ids: ['real/model', 'ghost/model'],
    });

    const body = parseResult(result) as { comparison: { id: string; found: boolean }[] };
    expect(body.comparison[1]?.found).toBe(false);
  });

  it('returns isError: true when a db lookup throws', async () => {
    mockGetModelById.mockRejectedValue(new Error('parallel failure'));
    const result = await toolHandlers['compare_models']!({ ids: ['x/1', 'x/2'] });
    expect(result.isError).toBe(true);
  });
});

describe('semantic_search tool', () => {
  it('returns isError: true when OPENROUTER_API_KEY is not set', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    const result = await toolHandlers['semantic_search']!({ query: 'fast cheap model', limit: 5, offset: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('OPENROUTER_API_KEY');
  });

  it('returns matching models when API key is present', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    const models = [makeModel({ id: 'fast/cheap' })];
    mockSemanticSearchModels.mockResolvedValueOnce(models);

    const result = await toolHandlers['semantic_search']!({
      query: 'fast cheap summarization',
      limit: 5,
      offset: 0,
    });

    delete process.env['OPENROUTER_API_KEY'];
    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { models: unknown[]; count: number };
    expect(body.count).toBe(1);
  });

  it('returns isError: true when embedding generation fails', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    mockGenerateEmbedding.mockRejectedValueOnce(new Error('embedding API error'));

    const result = await toolHandlers['semantic_search']!({ query: 'something', limit: 5, offset: 0 });

    delete process.env['OPENROUTER_API_KEY'];
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('embedding API error');
  });
});

describe('get_registry_status tool', () => {
  it('returns the sync status', async () => {
    const status = makeSyncStatus({ recordCount: 150 });
    mockGetSyncStatus.mockResolvedValueOnce(status);

    const result = await toolHandlers['get_registry_status']!({});

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { status: SyncStatus };
    expect(body.status.recordCount).toBe(150);
  });

  it('merges live model counts into the status so recordCount can be reconciled', async () => {
    mockGetSyncStatus.mockResolvedValueOnce(makeSyncStatus({ recordCount: 150 }));
    mockGetModelCounts.mockResolvedValueOnce({ total: 180, available: 150, retired: 30 });

    const result = await toolHandlers['get_registry_status']!({});

    const body = parseResult(result) as {
      status: { recordCount: number; totalCount: number; availableCount: number; retiredCount: number };
    };
    expect(body.status.recordCount).toBe(150);
    expect(body.status.totalCount).toBe(180);
    expect(body.status.availableCount).toBe(150);
    expect(body.status.retiredCount).toBe(30);
    expect(body.status.availableCount + body.status.retiredCount).toBe(body.status.totalCount);
  });

  it('returns status: null when no sync has occurred', async () => {
    mockGetSyncStatus.mockResolvedValueOnce(null);
    const result = await toolHandlers['get_registry_status']!({});
    const body = parseResult(result) as { status: null };
    expect(body.status).toBeNull();
  });

  it('returns isError: true on db error', async () => {
    mockGetSyncStatus.mockRejectedValueOnce(new Error('table missing'));
    const result = await toolHandlers['get_registry_status']!({});
    expect(result.isError).toBe(true);
  });
});

describe('get_sync_history tool', () => {
  it('returns sync history entries', async () => {
    const entries = [
      makeSyncHistoryEntry({ id: 1, recordCount: 100 }),
      makeSyncHistoryEntry({ id: 2, success: false, error: 'rate limit', recordCount: null }),
    ];
    mockGetSyncHistory.mockResolvedValueOnce(entries);

    const result = await toolHandlers['get_sync_history']!({ limit: 50 });

    expect(result.isError).toBeUndefined();
    const body = parseResult(result) as { history: SyncHistoryEntry[]; count: number };
    expect(body.count).toBe(2);
    expect(body.history[1]?.success).toBe(false);
    expect(body.history[1]?.error).toBe('rate limit');
  });

  it('returns an empty history when no entries exist', async () => {
    mockGetSyncHistory.mockResolvedValueOnce([]);
    const result = await toolHandlers['get_sync_history']!({ limit: 50 });
    const body = parseResult(result) as { count: number };
    expect(body.count).toBe(0);
  });

  it('returns isError: true on db error', async () => {
    mockGetSyncHistory.mockRejectedValueOnce(new Error('history table unavailable'));
    const result = await toolHandlers['get_sync_history']!({ limit: 50 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('history table unavailable');
  });
});

describe('model projection (verbose / fields)', () => {
  const verboseModel = makeModel({
    id: 'p/model',
    description: 'A very long model description',
    metadata: { architecture: { tokenizer: 'test' } },
  });

  /** Read the first projected record out of a list-style tool response. */
  function firstRecord(result: ToolResult): Record<string, unknown> {
    const body = parseResult(result) as { models: Record<string, unknown>[] };
    return body.models[0] as Record<string, unknown>;
  }

  it('omits description and metadata by default (verbose is false)', async () => {
    mockGetModels.mockResolvedValueOnce([verboseModel]);

    const result = await toolHandlers['list_models']!({ limit: 10, offset: 0, verbose: false });

    const record = firstRecord(result);
    expect(record).not.toHaveProperty('description');
    expect(record).not.toHaveProperty('metadata');
    // Everything else survives.
    expect(record['id']).toBe('p/model');
    expect(record['displayName']).toBe('Test Model');
    expect(record['inputPricePer1k']).toBe(0.001);
    expect(record['isAvailable']).toBe(true);
  });

  it('includes description and metadata when verbose is true', async () => {
    mockGetModels.mockResolvedValueOnce([verboseModel]);

    const result = await toolHandlers['list_models']!({ limit: 10, offset: 0, verbose: true });

    const record = firstRecord(result);
    expect(record['description']).toBe('A very long model description');
    expect(record['metadata']).toEqual({ architecture: { tokenizer: 'test' } });
  });

  it('returns only the requested fields, always including id', async () => {
    mockGetModels.mockResolvedValueOnce([verboseModel]);

    const result = await toolHandlers['list_models']!({
      limit: 10,
      offset: 0,
      verbose: false,
      fields: ['displayName', 'inputPricePer1k'],
    });

    expect(Object.keys(firstRecord(result))).toEqual(['id', 'displayName', 'inputPricePer1k']);
  });

  // The old behaviour -- unknown names dropped silently -- meant an agent that
  // typo'd a field got a 200 with the datum missing and could reasonably
  // conclude the datum did not exist. It is now a validation error.
  //
  // These assert against the captured schema, not the handler: the handler
  // never sees an unknown name any more, so asserting on its output would
  // prove nothing about what the wire protocol accepts.

  it('rejects an unknown field name instead of silently dropping it', () => {
    const parsed = parseToolInput('list_models', {
      fields: ['displayName', 'notAFieldAtAll'],
    });

    expect(parsed.success).toBe(false);
  });

  it('names the offending value in the validation error', () => {
    const parsed = parseToolInput('list_models', { fields: ['notAFieldAtAll'] });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('fields');
    }
  });

  it('rejects a snake_case spelling that sortBy would have accepted', () => {
    // sortBy takes both casings; fields does not. Worth pinning, because that
    // inconsistency is exactly what an agent would guess wrong about -- and now
    // it gets told, rather than getting a record with the column missing.
    expect(parseToolInput('list_models', { fields: ['display_name'] }).success).toBe(false);
    expect(parseToolInput('list_models', { sortBy: 'display_name' }).success).toBe(true);
  });

  it('rejects prototype-chain names that the old `in` guard let through', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(parseToolInput('list_models', { fields: [name] }).success).toBe(false);
    }
  });

  it('accepts every field of the Model record', () => {
    const everyField = Object.keys(verboseModel);

    const parsed = parseToolInput('list_models', { fields: everyField });

    // Guards the enum against drifting behind the Model type: a field that
    // exists on the record but not in the enum would fail here.
    expect(parsed.success).toBe(true);
  });

  it('enforces the same field names on every tool that takes a projection', () => {
    for (const tool of ['list_models', 'search_models', 'find_models_by_criteria', 'semantic_search']) {
      expect(parseToolInput(tool, { query: 'x', fields: ['displayName'] }).success).toBe(true);
      expect(parseToolInput(tool, { query: 'x', fields: ['nope'] }).success).toBe(false);
    }
  });

  it('does not duplicate id when it is requested explicitly', async () => {
    mockGetModels.mockResolvedValueOnce([verboseModel]);

    const result = await toolHandlers['list_models']!({ limit: 10, offset: 0, fields: ['id'] });

    expect(Object.keys(firstRecord(result))).toEqual(['id']);
  });

  it('lets fields win over verbose', async () => {
    mockGetModels.mockResolvedValueOnce([verboseModel]);

    const result = await toolHandlers['list_models']!({
      limit: 10,
      offset: 0,
      verbose: true,
      fields: ['description'],
    });

    const record = firstRecord(result);
    expect(Object.keys(record)).toEqual(['id', 'description']);
    expect(record['description']).toBe('A very long model description');
  });

  it('applies to search_models', async () => {
    mockGetModels.mockResolvedValueOnce([verboseModel]);
    const result = await toolHandlers['search_models']!({ query: 'p', limit: 20, offset: 0, verbose: false });
    expect(firstRecord(result)).not.toHaveProperty('description');
  });

  it('applies to find_models_by_criteria', async () => {
    mockFindModelsByCriteria.mockResolvedValueOnce([verboseModel]);
    const result = await toolHandlers['find_models_by_criteria']!({ limit: 50, offset: 0, verbose: false });
    expect(firstRecord(result)).not.toHaveProperty('metadata');
  });

  it('applies to semantic_search', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSemanticSearchModels.mockResolvedValueOnce([verboseModel]);

    const result = await toolHandlers['semantic_search']!({ query: 'anything', limit: 5, offset: 0, verbose: false });

    delete process.env['OPENROUTER_API_KEY'];
    expect(firstRecord(result)).not.toHaveProperty('description');
  });

  it('keeps full records in get_model (never projected)', async () => {
    mockGetModelById.mockResolvedValueOnce(verboseModel);
    const result = await toolHandlers['get_model']!({ id: 'p/model' });
    const body = parseResult(result) as { model: Record<string, unknown> };
    expect(body.model['description']).toBe('A very long model description');
    expect(body.model['metadata']).toEqual({ architecture: { tokenizer: 'test' } });
  });
});

describe('camelCase sortBy (P6)', () => {
  it('passes a camelCase sortBy straight through to list_models db query', async () => {
    mockGetModels.mockResolvedValueOnce([]);

    await toolHandlers['list_models']!({ limit: 10, offset: 0, sortBy: 'createdAt', sortDir: 'desc' });

    expect(mockGetModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'createdAt', sortDir: 'desc' })
    );
  });

  it('passes a camelCase sortBy straight through to search_models', async () => {
    mockGetModels.mockResolvedValueOnce([]);

    await toolHandlers['search_models']!({ query: 'x', limit: 20, offset: 0, sortBy: 'inputPricePer1k' });

    expect(mockGetModels).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'inputPricePer1k' }));
  });

  it('passes a camelCase sortBy straight through to find_models_by_criteria', async () => {
    mockFindModelsByCriteria.mockResolvedValueOnce([]);

    await toolHandlers['find_models_by_criteria']!({ limit: 50, offset: 0, sortBy: 'contextLength' });

    expect(mockFindModelsByCriteria).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: 'contextLength' })
    );
  });

  it('still accepts the snake_case spelling', async () => {
    mockGetModels.mockResolvedValueOnce([]);

    await toolHandlers['list_models']!({ limit: 10, offset: 0, sortBy: 'created_at' });

    expect(mockGetModels).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'created_at' }));
  });
});

// ── Per-client tool budget ────────────────────────────────────────────────────
// Dynamic client registration is deliberately open, so the brake that matters
// is on USING a token, not acquiring one. Before this existed, /api/mcp had no
// rate limiting at all and a self-registered client could call tools unbounded.

describe('per-client tool rate limiting', () => {
  beforeEach(() => {
    mockCheckRateLimit.mockReset();
    mockCheckRateLimit.mockResolvedValue(true);
    // These assert "was not called", so earlier suites' calls must not count.
    mockGetModels.mockClear();
    mockGenerateEmbedding.mockClear();
  });

  it('charges every tool call against the calling client', async () => {
    mockGetModels.mockResolvedValueOnce([]);

    await toolHandlers['list_models']!({ offset: 0 });

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('returns an error result instead of running the tool when the budget is spent', async () => {
    mockCheckRateLimit.mockResolvedValueOnce(false);
    mockGetModels.mockResolvedValueOnce([makeModel()]);

    const result = await toolHandlers['list_models']!({ offset: 0 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('rate limit exceeded');
    // The negative half: the handler must not have reached the database.
    expect(mockGetModels).not.toHaveBeenCalled();
  });

  it('gives semantic_search its own tighter budget', async () => {
    mockGenerateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    mockSemanticSearchModels.mockResolvedValueOnce([]);

    await toolHandlers['semantic_search']!({ query: 'fast cheap model', limit: 10, offset: 0 });

    const [key, opts] = mockCheckRateLimit.mock.calls[0] as unknown as [
      string,
      { limit: number; windowMs: number },
    ];
    expect(key).toContain('semantic_search');
    expect(opts.limit).toBeLessThan(600);
  });

  it('does not spend an embedding call when semantic_search is throttled', async () => {
    mockCheckRateLimit.mockResolvedValueOnce(false);

    const result = await toolHandlers['semantic_search']!({
      query: 'fast cheap model',
      limit: 10,
      offset: 0,
    });

    expect(result.isError).toBe(true);
    // semantic_search is the only tool that spends money. Throttling it must
    // happen before the paid outbound embedding request, not after.
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  it('keys the budget on the OAuth client id', async () => {
    mockGetModels.mockResolvedValueOnce([]);

    await toolHandlers['list_models']!({ offset: 0 }, { authInfo: { clientId: 'client-abc' } });

    const [key] = mockCheckRateLimit.mock.calls[0] as unknown as [string];
    expect(key).toContain('client-abc');
  });

  it('does not let one client spend another client budget', async () => {
    mockGetModels.mockResolvedValue([]);

    await toolHandlers['list_models']!({ offset: 0 }, { authInfo: { clientId: 'client-a' } });
    await toolHandlers['list_models']!({ offset: 0 }, { authInfo: { clientId: 'client-b' } });

    const [keyA] = mockCheckRateLimit.mock.calls[0] as unknown as [string];
    const [keyB] = mockCheckRateLimit.mock.calls[1] as unknown as [string];
    expect(keyA).not.toBe(keyB);
  });
});
