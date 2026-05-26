/**
 * @file mcp-tools.test.ts
 * Unit tests for the MCP server tool handlers defined in apps/mcp.
 * The MCP SDK and all db/embedding dependencies are mocked so no network
 * or database connections are required.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Model, SyncStatus, SyncHistoryEntry } from '@openrouter-mcp/shared';

// ── Hoisted shared state (captured tool handlers) ─────────────────────────────
// vi.hoisted runs before module-level code, so the factory can reference this
// variable safely even though vi.mock calls are hoisted above imports.

const toolHandlers = vi.hoisted(
  () => ({} as Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>)
);

type ContentItem = { type: string; text: string };
type ToolResult = { content: ContentItem[]; isError?: boolean };

// ── Mock the MCP SDK ──────────────────────────────────────────────────────────

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(
      (
        name: string,
        _desc: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<ToolResult>
      ) => {
        toolHandlers[name] = handler;
      }
    ),
    resource: vi.fn(),
    prompt: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
  ResourceTemplate: vi.fn().mockImplementation((template: string) => ({ template })),
}));

// ── Mock db module ────────────────────────────────────────────────────────────

const mockGetModels = vi.fn<[], Promise<Model[]>>();
const mockGetModelById = vi.fn<[string], Promise<Model | null>>();
const mockGetSyncStatus = vi.fn<[], Promise<SyncStatus | null>>();
const mockGetSyncHistory = vi.fn<[number?], Promise<SyncHistoryEntry[]>>();
const mockFindModelsByCriteria = vi.fn<[], Promise<Model[]>>();
const mockSemanticSearchModels = vi.fn<[], Promise<Model[]>>();

vi.mock('../lib/db', () => ({
  getModels: (...args: unknown[]) => mockGetModels(...(args as [])),
  getModelById: (...args: unknown[]) => mockGetModelById(...(args as [string])),
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...(args as [])),
  getSyncHistory: (...args: unknown[]) => mockGetSyncHistory(...(args as [number?])),
  findModelsByCriteria: (...args: unknown[]) => mockFindModelsByCriteria(...(args as [])),
  semanticSearchModels: (...args: unknown[]) => mockSemanticSearchModels(...(args as [])),
}));

// ── Mock embeddings module ────────────────────────────────────────────────────

const mockGenerateEmbedding = vi.fn<[], Promise<number[]>>();

vi.mock('../lib/embeddings', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...(args as [])),
}));

// ── Mock Next.js server internals (not needed for tool tests) ─────────────────

vi.mock('../lib/auth', () => ({
  validateAdminToken: vi.fn().mockReturnValue(null),
  validateMcpToken: vi.fn().mockReturnValue(null),
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
    success: true,
    recordCount: 42,
    error: null,
    ...overrides,
  };
}

/** Parse the JSON payload from the first content item of a tool result. */
function parseResult(result: ToolResult): unknown {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text);
}

// ── Populate tool handlers by calling createMcpServer ────────────────────────

beforeAll(async () => {
  const { createMcpServer } = await import('../lib/mcpServer');
  createMcpServer();
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
