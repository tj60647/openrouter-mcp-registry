/**
 * @file tool-schemas.test.ts
 * Validation tests for the MCP tool input schemas.
 *
 * The tool tests in mcp-tools.test.ts exercise handler behaviour with the SDK
 * mocked, and that mock used to bind the schema argument to `_schema` and drop
 * it — so zod never executed in any test. The builders ran at registration time
 * but nothing was ever parsed, leaving every `.min()`, `.max()`, `.enum()` and
 * `.default()` covered by nothing. Worse, several handler tests hand-pass the
 * defaults, which would keep them passing even if the defaults were deleted.
 *
 * This file registers the real tools against a mock that keeps the ZodRawShape,
 * then parses input the way the wire protocol does. It is about what the server
 * accepts, not about what the handlers then do with it.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

// ── Mock the MCP SDK, keeping the schema ──────────────────────────────────────
// The real call is the 4-arg overload server.tool(name, description,
// paramsSchema, handler), where paramsSchema is a ZodRawShape — a plain object
// of zod schemas, not a z.object() and not JSON Schema. instrumentUsage rewraps
// the LAST argument before this sees it, so args[2] is still the schema.

const toolSchemas = vi.hoisted(() => ({}) as Record<string, Record<string, ZodTypeAny>>);

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn((...args: unknown[]) => {
      const schema = args.length > 3 ? args[2] : undefined;
      if (schema && typeof schema === 'object') {
        toolSchemas[args[0] as string] = schema as Record<string, ZodTypeAny>;
      }
    }),
    resource: vi.fn(),
    prompt: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
  ResourceTemplate: vi.fn().mockImplementation((template: string) => ({ template })),
}));

// The registry only needs to register; nothing here calls a handler.
vi.mock('../lib/db', () => ({
  getModels: vi.fn(),
  getModelsCount: vi.fn(),
  getModelCounts: vi.fn(),
  getModelById: vi.fn(),
  getSyncStatus: vi.fn(),
  getSyncHistory: vi.fn(),
  findModelsByCriteria: vi.fn(),
  findModelsByCriteriaCount: vi.fn(),
  semanticSearchModels: vi.fn(),
}));
vi.mock('../lib/embeddings', () => ({ generateEmbedding: vi.fn() }));
vi.mock('../lib/oauthStore', () => ({ recordUsage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/rateLimit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }));

beforeAll(async () => {
  const { initMcpServer } = await import('../lib/mcp-server');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  await initMcpServer(new McpServer({ name: 'test', version: '0.0.0' }));
});

/** Parse tool input exactly as the MCP server would before calling a handler. */
function parseToolInput(tool: string, input: unknown) {
  const shape = toolSchemas[tool];
  if (!shape) throw new Error(`no schema captured for tool "${tool}"`);
  return z.object(shape).safeParse(input);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tool input schemas', () => {
  it('captures a schema for every registered tool', () => {
    // Without this, a mock that silently stopped capturing would make every
    // test below throw rather than fail with a useful message.
    expect(Object.keys(toolSchemas).sort()).toEqual([
      'compare_models',
      'find_models_by_criteria',
      'get_model',
      'get_registry_status',
      'get_sync_history',
      'list_models',
      'resolve_model',
      'search_models',
      'semantic_search',
    ]);
  });
});

// ── Numeric bounds ────────────────────────────────────────────────────────────

describe('numeric bounds', () => {
  const CASES: Array<{
    tool: string;
    field: string;
    min: number;
    max?: number;
    /** Other fields the tool requires for the input to be otherwise valid. */
    rest?: Record<string, unknown>;
  }> = [
    { tool: 'list_models', field: 'limit', min: 1 },
    { tool: 'list_models', field: 'offset', min: 0 },
    { tool: 'search_models', field: 'limit', min: 1, max: 100, rest: { query: 'x' } },
    { tool: 'search_models', field: 'offset', min: 0, rest: { query: 'x' } },
    { tool: 'find_models_by_criteria', field: 'limit', min: 1, max: 200 },
    { tool: 'find_models_by_criteria', field: 'offset', min: 0 },
    { tool: 'semantic_search', field: 'limit', min: 1, max: 50, rest: { query: 'x' } },
    { tool: 'semantic_search', field: 'offset', min: 0, rest: { query: 'x' } },
    { tool: 'get_sync_history', field: 'limit', min: 1, max: 200 },
  ];

  for (const { tool, field, min, max, rest = {} } of CASES) {
    const parse = (value: unknown) => parseToolInput(tool, { ...rest, [field]: value });

    it(`${tool}.${field} accepts its minimum of ${min}`, () => {
      expect(parse(min).success).toBe(true);
    });

    it(`${tool}.${field} rejects ${min - 1}, one below its minimum`, () => {
      expect(parse(min - 1).success).toBe(false);
    });

    if (max !== undefined) {
      it(`${tool}.${field} accepts its maximum of ${max}`, () => {
        expect(parse(max).success).toBe(true);
      });

      it(`${tool}.${field} rejects ${max + 1}, one above its maximum`, () => {
        expect(parse(max + 1).success).toBe(false);
      });
    }

    it(`${tool}.${field} rejects a fractional value`, () => {
      expect(parse(min + 0.5).success).toBe(false);
    });

    it(`${tool}.${field} rejects a numeric string rather than coercing it`, () => {
      // Unlike the REST PaginationSchema, tool schemas do not coerce. An agent
      // sending "10" is told so, rather than silently getting the default.
      expect(parse(String(min)).success).toBe(false);
    });

    it(`${tool}.${field} rejects NaN and Infinity`, () => {
      expect(parse(Number.NaN).success).toBe(false);
      expect(parse(Number.POSITIVE_INFINITY).success).toBe(false);
    });
  }

  it('list_models.limit has no upper bound, so a full-catalogue pull is expressible', () => {
    expect(parseToolInput('list_models', { limit: 100_000 }).success).toBe(true);
  });
});

// ── String bounds ─────────────────────────────────────────────────────────────

describe('string bounds', () => {
  const CASES: Array<{ tool: string; field: string; max: number }> = [
    { tool: 'resolve_model', field: 'input', max: 256 },
    { tool: 'get_model', field: 'id', max: 256 },
    { tool: 'search_models', field: 'query', max: 256 },
    { tool: 'semantic_search', field: 'query', max: 1000 },
  ];

  for (const { tool, field, max } of CASES) {
    const parse = (value: unknown) => parseToolInput(tool, { [field]: value });

    it(`${tool}.${field} rejects an empty string`, () => {
      expect(parse('').success).toBe(false);
    });

    it(`${tool}.${field} accepts exactly ${max} characters`, () => {
      expect(parse('a'.repeat(max)).success).toBe(true);
    });

    it(`${tool}.${field} rejects ${max + 1} characters`, () => {
      // This bound is what stops an agent pasting a whole document into a
      // parameter that reaches the database or a paid embedding call.
      expect(parse('a'.repeat(max + 1)).success).toBe(false);
    });

    it(`${tool}.${field} is required`, () => {
      expect(parseToolInput(tool, {}).success).toBe(false);
    });

    it(`${tool}.${field} rejects a non-string`, () => {
      expect(parse(42).success).toBe(false);
      expect(parse(null).success).toBe(false);
    });
  }
});

// ── compare_models array bounds ───────────────────────────────────────────────

describe('compare_models', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `p/m${i}`);

  it('requires at least 2 ids', () => {
    expect(parseToolInput('compare_models', { ids: ids(1) }).success).toBe(false);
    expect(parseToolInput('compare_models', { ids: [] }).success).toBe(false);
  });

  it('accepts 2 to 5 ids and rejects 6', () => {
    expect(parseToolInput('compare_models', { ids: ids(2) }).success).toBe(true);
    expect(parseToolInput('compare_models', { ids: ids(5) }).success).toBe(true);
    // Each id is its own getModelById round trip, so the cap is the brake.
    expect(parseToolInput('compare_models', { ids: ids(6) }).success).toBe(false);
  });

  it('bounds each id, not just the array', () => {
    expect(parseToolInput('compare_models', { ids: ['a/b', ''] }).success).toBe(false);
    expect(parseToolInput('compare_models', { ids: ['a/b', 'x'.repeat(257)] }).success).toBe(false);
  });
});

// ── Enums ─────────────────────────────────────────────────────────────────────

describe('enums', () => {
  it('sortBy accepts both casings of the same column and rejects anything else', () => {
    for (const value of ['created_at', 'createdAt', 'input_price_per_1k', 'inputPricePer1k']) {
      expect(parseToolInput('list_models', { sortBy: value }).success).toBe(true);
    }
    for (const value of ['newest', 'name', 'price', 'created_at DESC', '']) {
      expect(parseToolInput('list_models', { sortBy: value }).success).toBe(false);
    }
  });

  it('sortBy rejects a value that would reach an interpolated ORDER BY', () => {
    // sortBy is interpolated into SQL after a whitelist lookup in db.ts. The
    // enum is the outer of two guards; neither should be the only one.
    expect(parseToolInput('list_models', { sortBy: 'id; DROP TABLE models' }).success).toBe(false);
    expect(parseToolInput('list_models', { sortBy: 'constructor' }).success).toBe(false);
  });

  it('sortDir accepts only asc and desc', () => {
    expect(parseToolInput('list_models', { sortDir: 'asc' }).success).toBe(true);
    expect(parseToolInput('list_models', { sortDir: 'desc' }).success).toBe(true);
    for (const value of ['ASC', 'ascending', 'up', '']) {
      expect(parseToolInput('list_models', { sortDir: value }).success).toBe(false);
    }
  });

  it('boolean flags are not coerced from strings', () => {
    for (const field of ['availableOnly', 'verbose']) {
      expect(parseToolInput('list_models', { [field]: true }).success).toBe(true);
      expect(parseToolInput('list_models', { [field]: 'true' }).success).toBe(false);
      expect(parseToolInput('list_models', { [field]: 1 }).success).toBe(false);
    }
  });
});

// ── Defaults ──────────────────────────────────────────────────────────────────
// Asserted on the parsed OUTPUT rather than by passing them in. Several handler
// tests hand-pass sortBy/sortDir/availableOnly, so they would keep passing even
// if the defaults were removed entirely.

describe('defaults', () => {
  it('applies list_models defaults to an empty input', () => {
    const parsed = parseToolInput('list_models', {});

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        offset: 0,
        sortBy: 'id',
        sortDir: 'asc',
        availableOnly: false,
        verbose: false,
      });
      // limit is deliberately undefined, not 0 and not 500: omitting it returns
      // every matching record, which is what commit 1aaf9e4 made the default.
      expect(parsed.data['limit']).toBeUndefined();
    }
  });

  it('applies the documented page-size defaults', () => {
    const cases: Array<[string, number, Record<string, unknown>]> = [
      ['search_models', 20, { query: 'x' }],
      ['find_models_by_criteria', 50, {}],
      ['semantic_search', 10, { query: 'x' }],
      ['get_sync_history', 50, {}],
    ];

    for (const [tool, expected, rest] of cases) {
      const parsed = parseToolInput(tool, rest);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data['limit']).toBe(expected);
    }
  });

  it('leaves every find_models_by_criteria filter optional', () => {
    const parsed = parseToolInput('find_models_by_criteria', {});

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data['maxInputPricePer1k']).toBeUndefined();
      expect(parsed.data['minContextLength']).toBeUndefined();
      expect(parsed.data['modality']).toBeUndefined();
    }
  });

  it('rejects a negative price filter and a non-positive context filter', () => {
    expect(parseToolInput('find_models_by_criteria', { maxInputPricePer1k: -1 }).success).toBe(false);
    expect(parseToolInput('find_models_by_criteria', { maxOutputPricePer1k: -0.1 }).success).toBe(false);
    expect(parseToolInput('find_models_by_criteria', { minContextLength: 0 }).success).toBe(false);
    // Zero is a legitimate maximum price (free models only); zero context is not.
    expect(parseToolInput('find_models_by_criteria', { maxInputPricePer1k: 0 }).success).toBe(true);
  });

  it('treats an empty fields array as not supplied', () => {
    expect(parseToolInput('list_models', { fields: [] }).success).toBe(true);
  });
});
