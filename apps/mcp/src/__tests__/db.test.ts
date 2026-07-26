/**
 * @file db.test.ts
 * Unit tests for apps/mcp database query helpers.
 * The @vercel/postgres module is mocked so no real DB connection is needed.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelRow } from '@openrouter-mcp/shared';
import type { SyncStatusRow, SyncHistoryRow } from '@openrouter-mcp/shared';

// ── Mock @vercel/postgres ─────────────────────────────────────────────────────
// vi.hoisted is required because vi.mock factories are hoisted before const
// declarations, so mockQuery/mockSql would be uninitialized at execution time
// without this.

const { mockQuery, mockSql } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('@vercel/postgres', () => ({
  sql: mockSql,
  db: { query: mockQuery },
}));

// ── Import module under test after mock registration ─────────────────────────

import {
  getModels,
  getModelById,
  getProviders,
  getSyncStatus,
  getSyncHistory,
  findModelsByCriteria,
  getModelsCount,
} from '../lib/db';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeModelRow(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'test/model',
    provider: 'test',
    display_name: 'Test Model',
    description: null,
    modality: 'text->text',
    context_length: 4096,
    max_completion_tokens: null,
    input_price_per_1k: '0.001',
    output_price_per_1k: '0.002',
    image_price_per_1k: null,
    created_at: new Date('2024-01-01'),
    provider_expiration_at: null,
    supported_parameters: ['tools'],
    metadata: {},
    fetched_at: new Date('2024-01-01'),
    last_seen_at: new Date('2024-01-01'),
    retired_at: null,
    is_available: true,
    ...overrides,
  };
}

function makeSyncStatusRow(overrides: Partial<SyncStatusRow> = {}): SyncStatusRow {
  return {
    id: 1,
    last_successful_sync: new Date('2024-06-01T12:00:00Z'),
    last_attempted_sync: new Date('2024-06-01T12:00:00Z'),
    last_error: null,
    record_count: 42,
    ...overrides,
  };
}

function makeSyncHistoryRow(overrides: Partial<SyncHistoryRow> = {}): SyncHistoryRow {
  return {
    id: 1,
    synced_at: new Date('2024-06-01T12:00:00Z'),
    success: true,
    record_count: 42,
    error: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getModels', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns an empty array when the db returns no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getModels({ limit: 10, offset: 0 });
    expect(result).toEqual([]);
  });

  it('returns transformed Model objects from db rows', async () => {
    const row = makeModelRow();
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const result = await getModels({ limit: 10, offset: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('test/model');
    expect(result[0]?.provider).toBe('test');
    expect(result[0]?.displayName).toBe('Test Model');
    expect(result[0]?.contextLength).toBe(4096);
    expect(result[0]?.inputPricePer1k).toBe(0.001);
  });

  it('passes the provider filter to the query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, provider: 'anthropic' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('provider = $1');
    expect(params).toContain('anthropic');
  });

  it('emits no LIMIT clause when limit is omitted (full-catalogue pull)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ offset: 0 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('LIMIT');
    expect(sql).not.toContain('OFFSET');
    expect(params).toHaveLength(0);
  });

  it('numbers LIMIT/OFFSET placeholders after the WHERE params', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 20, provider: 'anthropic' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('provider = $1');
    expect(sql).toContain('LIMIT $2');
    expect(sql).toContain('OFFSET $3');
    expect(params).toEqual(['anthropic', 10, 20]);
  });

  it('numbers OFFSET correctly when limit is omitted but offset is set', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ offset: 20, provider: 'anthropic' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('LIMIT');
    expect(sql).toContain('OFFSET $2');
    expect(params).toEqual(['anthropic', 20]);
  });

  it('passes the text query filter (ILIKE) to the query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, query: 'claude' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ILIKE/i);
    expect(params).toContain('%claude%');
  });

  it('adds toolsOnly filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, toolsOnly: true });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'tools' = ANY(supported_parameters)");
  });

  it('adds reasoningOnly filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, reasoningOnly: true });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("'reasoning' = ANY(supported_parameters)");
  });

  it('adds availableOnly filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, availableOnly: true });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('is_available = TRUE');
  });

  it('adds retiredOnly filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, retiredOnly: true });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('is_available = FALSE');
  });

  it('uses raw column name aliases for sortBy', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, sortBy: 'created_at', sortDir: 'desc' });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY created_at DESC');
  });

  it('uses PaginationSchema alias "newest" for sortBy', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, sortBy: 'newest' });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY created_at ASC');
  });

  it('appends NULLS LAST for nullable sort columns', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0, sortBy: 'input_price_per_1k', sortDir: 'asc' });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('NULLS LAST');
  });

  it('defaults to ORDER BY id ASC with no sort options', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModels({ limit: 10, offset: 0 });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY id ASC');
    expect(sql).not.toContain('NULLS LAST');
  });
});

describe('getModelsCount', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns the count as a number', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    const count = await getModelsCount({});
    expect(count).toBe(7);
  });

  it('returns 0 when there are no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const count = await getModelsCount({});
    expect(count).toBe(0);
  });

  it('applies availableOnly filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    await getModelsCount({ availableOnly: true });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('is_available = TRUE');
  });
});

describe('getModelById', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns a Model when a matching row is found', async () => {
    const row = makeModelRow({ id: 'anthropic/claude-3' });
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const model = await getModelById('anthropic/claude-3');
    expect(model).not.toBeNull();
    expect(model?.id).toBe('anthropic/claude-3');
  });

  it('returns null when no matching row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const model = await getModelById('nonexistent/model');
    expect(model).toBeNull();
  });

  it('passes the id as a query parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getModelById('openai/gpt-4o');
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['openai/gpt-4o']);
  });
});

describe('getProviders', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns a list of provider strings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ provider: 'anthropic' }, { provider: 'openai' }, { provider: 'google' }],
    });
    const providers = await getProviders();
    expect(providers).toEqual(['anthropic', 'openai', 'google']);
  });

  it('returns an empty array when there are no providers', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const providers = await getProviders();
    expect(providers).toEqual([]);
  });
});

describe('getSyncStatus', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('returns null when no sync status row exists', async () => {
    mockSql.mockResolvedValueOnce({ rows: [] });
    const status = await getSyncStatus();
    expect(status).toBeNull();
  });

  it('returns a SyncStatus when a row exists', async () => {
    const row = makeSyncStatusRow({ record_count: 99 });
    mockSql.mockResolvedValueOnce({ rows: [row] });
    const status = await getSyncStatus();
    expect(status).not.toBeNull();
    expect(status?.recordCount).toBe(99);
    expect(status?.lastError).toBeNull();
  });

  it('maps last_error correctly', async () => {
    const row = makeSyncStatusRow({ last_error: 'connection refused', last_successful_sync: null });
    mockSql.mockResolvedValueOnce({ rows: [row] });
    const status = await getSyncStatus();
    expect(status?.lastError).toBe('connection refused');
    expect(status?.lastSuccessfulSync).toBeNull();
  });
});

describe('getSyncHistory', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns an empty array when there is no history', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const history = await getSyncHistory();
    expect(history).toEqual([]);
  });

  it('returns transformed history entries', async () => {
    const row = makeSyncHistoryRow({ id: 5, success: false, error: 'timeout', record_count: null });
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const history = await getSyncHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(5);
    expect(history[0]?.success).toBe(false);
    expect(history[0]?.error).toBe('timeout');
    expect(history[0]?.recordCount).toBeNull();
  });

  it('passes the default limit of 50 when called with no argument', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getSyncHistory();
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([50]);
  });

  it('passes a custom limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getSyncHistory(10);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([10]);
  });
});

describe('findModelsByCriteria', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns transformed models', async () => {
    const row = makeModelRow({ id: 'cheap/model', input_price_per_1k: '0.0001' });
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const models = await findModelsByCriteria({ limit: 10, offset: 0 });
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('cheap/model');
  });

  it('applies maxInputPricePer1k filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findModelsByCriteria({ maxInputPricePer1k: 0.01, limit: 10, offset: 0 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('input_price_per_1k IS NULL OR input_price_per_1k <=');
    expect(params).toContain(0.01);
  });

  it('applies maxOutputPricePer1k filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findModelsByCriteria({ maxOutputPricePer1k: 0.05, limit: 10, offset: 0 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('output_price_per_1k IS NULL OR output_price_per_1k <=');
    expect(params).toContain(0.05);
  });

  it('applies minContextLength filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findModelsByCriteria({ minContextLength: 32000, limit: 10, offset: 0 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('context_length >=');
    expect(params).toContain(32000);
  });

  it('applies modality filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findModelsByCriteria({ modality: 'text+image->text', limit: 10, offset: 0 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/modality ILIKE/i);
    expect(params).toContain('%text+image->text%');
  });

  it('applies sortBy and sortDir', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findModelsByCriteria({ sortBy: 'input_price_per_1k', sortDir: 'asc', limit: 10, offset: 0 });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ORDER BY input_price_per_1k ASC');
    expect(sql).toContain('NULLS LAST');
  });
});
