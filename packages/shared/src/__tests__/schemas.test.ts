/**
 * @file schemas.test.ts
 * Unit tests for the shared zod validation schemas. These schemas sit on the
 * outside edge of the registry — every model id, refresh request and listing
 * query from an HTTP route or an MCP tool call passes through them — so the
 * behaviour worth pinning is not "valid input parses" but exactly where each
 * boundary falls, which inputs are silently rewritten rather than rejected,
 * and which defaults are materialised into the parsed object.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect } from 'vitest';
import {
  ModelIdSchema,
  ResolveInputSchema,
  RefreshRequestSchema,
  PaginationSchema,
} from '../validation/schemas';

// ── ModelIdSchema ────────────────────────────────────────────────────────────

describe('ModelIdSchema', () => {
  const accepted = [
    ['a canonical anthropic id', 'anthropic/claude-sonnet-4-5'],
    ['a canonical openai id', 'openai/gpt-4o'],
    ['an id with an underscore', 'meta-llama/llama_3_70b'],
    ['an id with a colon-suffixed variant', 'anthropic/claude-3.5-sonnet:beta'],
    ['an id with a dotted version', 'mistralai/mistral-7b-instruct-v0.2'],
    ['a bare slug with no provider', 'gpt-4o'],
  ] as const;

  it.each(accepted)('accepts %s', (_label, id) => {
    const res = ModelIdSchema.safeParse(id);
    expect(res.success).toBe(true);
    // The schema must hand the id back byte-for-byte: nothing downstream
    // re-canonicalises it, so any trimming or lowercasing here would silently
    // change which row a lookup hits.
    expect(res.success && res.data).toBe(id);
  });

  it('rejects an empty id rather than treating it as "no filter"', () => {
    expect(ModelIdSchema.safeParse('').success).toBe(false);
  });

  it('accepts an id of exactly 256 characters', () => {
    const id = 'a'.repeat(256);
    const res = ModelIdSchema.safeParse(id);
    expect(res.success).toBe(true);
    expect(res.success && res.data.length).toBe(256);
  });

  it('rejects an id of 257 characters', () => {
    // The boundary is asserted from both sides so a future `.max(255)` or
    // `.max(512)` cannot slip through with the tests still green.
    expect(ModelIdSchema.safeParse('a'.repeat(257)).success).toBe(false);
  });

  const rejected = [
    ['a space', 'anthropic/claude sonnet'],
    ['a single quote', "anthropic/claude'--"],
    ['a semicolon', 'anthropic/claude; DROP TABLE models'],
    ['a percent-encoded traversal', 'anthropic/%2e%2e/secrets'],
    ['a trailing newline', 'anthropic/claude-3\n'],
    ['an embedded newline', 'anthropic/claude\nopenai/gpt-4o'],
    ['a NUL byte', 'anthropic/claude\u0000'],
    ['a backslash', 'anthropic\\claude'],
    ['an asterisk', 'anthropic/*'],
    ['whitespace padding around a valid id', ' openai/gpt-4o '],
  ] as const;

  it.each(rejected)('rejects an id containing %s', (_label, id) => {
    const res = ModelIdSchema.safeParse(id);
    expect(res.success).toBe(false);
    // A rejected id must not come back sanitised — callers branch on
    // `success`, and a stripped-but-successful parse would let a mangled id
    // reach the query layer.
    expect(res.success && res.data).toBeFalsy();
  });

  it('does NOT reject a path traversal, since "." and "/" are legal id characters', () => {
    // Surprising but real: `.` and `/` are both inside the character class, so
    // `../` passes while the encoded `%2e%2e` above does not. This schema
    // validates id *shape* only; it is not a path guard.
    //
    // Not currently exploitable: nothing in either app uses ModelIdSchema (the
    // /api/models/[id] route reads the path segment directly and passes it to a
    // parameterised query), so this pins a property of the exported schema, not
    // a live hole. It becomes load-bearing the moment someone validates with it
    // and then interpolates the result into a URL or filesystem path.
    expect(ModelIdSchema.safeParse('../').success).toBe(true);
    expect(ModelIdSchema.safeParse('../../etc/passwd').success).toBe(true);
  });
});

// ── ResolveInputSchema ───────────────────────────────────────────────────────

describe('ResolveInputSchema', () => {
  it('accepts a free-form alias, not just a canonical id', () => {
    const res = ResolveInputSchema.safeParse({ input: 'sonnet' });
    expect(res.success).toBe(true);
    expect(res.success && res.data.input).toBe('sonnet');
  });

  it('accepts an input of exactly 256 characters and rejects 257', () => {
    expect(ResolveInputSchema.safeParse({ input: 'a'.repeat(256) }).success).toBe(true);
    expect(ResolveInputSchema.safeParse({ input: 'a'.repeat(257) }).success).toBe(false);
  });

  it('rejects an empty input rather than resolving against the whole catalogue', () => {
    expect(ResolveInputSchema.safeParse({ input: '' }).success).toBe(false);
  });

  it('rejects a missing input key instead of defaulting it', () => {
    const res = ResolveInputSchema.safeParse({});
    expect(res.success).toBe(false);
    // No default exists for `input`, so nothing may be substituted for it.
    expect(res.success && res.data).toBeFalsy();
  });

  const nonStrings = [
    ['null', null],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['sonnet']],
    ['an object', { toString: 'sonnet' }],
  ] as const;

  it.each(nonStrings)('rejects %s as input without coercing it to a string', (_label, value) => {
    expect(ResolveInputSchema.safeParse({ input: value }).success).toBe(false);
  });
});

// ── RefreshRequestSchema ─────────────────────────────────────────────────────

describe('RefreshRequestSchema', () => {
  it('materialises force as false when the caller omits it', () => {
    const res = RefreshRequestSchema.safeParse({});
    expect(res.success).toBe(true);
    // The default must be present in the output, not merely implied: the
    // refresh handler reads `data.force` directly to decide whether to bypass
    // the freshness check.
    expect(res.success && res.data.force).toBe(false);
    expect(res.success && 'force' in res.data).toBe(true);
  });

  it('applies the default when force is explicitly undefined', () => {
    const res = RefreshRequestSchema.safeParse({ force: undefined });
    expect(res.success && res.data.force).toBe(false);
  });

  it('accepts a real boolean in either state', () => {
    const forced = RefreshRequestSchema.safeParse({ force: true });
    expect(forced.success && forced.data.force).toBe(true);
    const notForced = RefreshRequestSchema.safeParse({ force: false });
    expect(notForced.success && notForced.data.force).toBe(false);
  });

  const stringBooleans = [['true'], ['false'], ['1'], ['0']] as const;

  it.each(stringBooleans)('rejects the string %p instead of coercing it', (value) => {
    // Worth pinning because it is asymmetric with PaginationSchema, whose
    // boolean flags *do* accept 'true'/'1'. A query-string refresh request
    // (`?force=true`) therefore fails validation outright rather than quietly
    // forcing — or quietly not forcing — a sync.
    const res = RefreshRequestSchema.safeParse({ force: value });
    expect(res.success).toBe(false);
    expect(res.success && res.data.force).toBeFalsy();
  });
});

// ── PaginationSchema: defaults ───────────────────────────────────────────────

describe('PaginationSchema defaults', () => {
  it('fills every defaulted field when given an empty object', () => {
    const res = PaginationSchema.safeParse({});
    expect(res.success).toBe(true);
    expect(res.success && res.data).toEqual({
      limit: 100,
      offset: 0,
      sortBy: 'id',
      sortDir: 'asc',
      toolsOnly: false,
      reasoningOnly: false,
      availableOnly: false,
      retiredOnly: false,
    });
  });

  it('leaves the two optional strings absent rather than defaulting them to empty strings', () => {
    // `provider` and `query` have no default; an empty string would be a real
    // filter value downstream, so their absence has to survive parsing.
    const res = PaginationSchema.safeParse({});
    expect(res.success && 'provider' in res.data).toBe(false);
    expect(res.success && 'query' in res.data).toBe(false);
  });

  it('ignores unknown keys instead of failing or passing them through', () => {
    const res = PaginationSchema.safeParse({ cursor: 'abc', sortby: 'newest' });
    expect(res.success).toBe(true);
    // A mis-cased `sortby` is dropped silently, so the caller gets the default
    // sort rather than an error telling them their parameter was misspelled.
    expect(res.success && 'cursor' in res.data).toBe(false);
    expect(res.success && res.data.sortBy).toBe('id');
  });
});

// ── PaginationSchema: limit and offset ───────────────────────────────────────

describe('PaginationSchema limit', () => {
  it('coerces a query-string limit into a number', () => {
    const res = PaginationSchema.safeParse({ limit: '50' });
    expect(res.success).toBe(true);
    expect(res.success && res.data.limit).toBe(50);
    // The coercion is the point: a leftover string would be interpolated into
    // a SQL LIMIT or compared with `<` against a count.
    expect(res.success && res.data.limit).not.toBe('50');
    expect(res.success && typeof res.data.limit).toBe('number');
  });

  it('accepts both ends of the allowed range', () => {
    const lower = PaginationSchema.safeParse({ limit: 1 });
    expect(lower.success && lower.data.limit).toBe(1);
    const upper = PaginationSchema.safeParse({ limit: 500 });
    expect(upper.success && upper.data.limit).toBe(500);
  });

  it('rejects a limit just outside either end of the range', () => {
    // Asserted at 0/501 rather than at 0/1000 so the bound cannot drift
    // without a test failing.
    expect(PaginationSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ limit: 501 }).success).toBe(false);
  });

  it('rejects an out-of-range limit rather than clamping it to the maximum', () => {
    const res = PaginationSchema.safeParse({ limit: 100000 });
    expect(res.success).toBe(false);
    expect(res.success && res.data.limit).not.toBe(500);
  });

  it('rejects a non-integer limit whether it arrives as a number or a string', () => {
    expect(PaginationSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ limit: '1.5' }).success).toBe(false);
  });

  it('rejects a limit that is not numeric at all', () => {
    expect(PaginationSchema.safeParse({ limit: 'all' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ limit: '' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ limit: null }).success).toBe(false);
  });
});

describe('PaginationSchema offset', () => {
  it('coerces a query-string offset into a number', () => {
    const res = PaginationSchema.safeParse({ offset: '200' });
    expect(res.success).toBe(true);
    expect(res.success && res.data.offset).toBe(200);
    expect(res.success && res.data.offset).not.toBe('200');
  });

  it('accepts zero as a real offset, distinct from the default', () => {
    const res = PaginationSchema.safeParse({ offset: '0' });
    expect(res.success && res.data.offset).toBe(0);
  });

  it('rejects a negative offset rather than flooring it to zero', () => {
    const res = PaginationSchema.safeParse({ offset: -1 });
    expect(res.success).toBe(false);
    expect(res.success && res.data.offset).not.toBe(0);
  });

  it('rejects a non-integer offset', () => {
    expect(PaginationSchema.safeParse({ offset: 1.5 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ offset: '1.5' }).success).toBe(false);
  });
});

// ── PaginationSchema: sortBy and sortDir ─────────────────────────────────────

describe('PaginationSchema sort options', () => {
  const sortKeys = [['id'], ['newest'], ['context'], ['input_price'], ['output_price']] as const;

  it.each(sortKeys)('accepts %s as a sort key', (key) => {
    const res = PaginationSchema.safeParse({ sortBy: key });
    expect(res.success).toBe(true);
    expect(res.success && res.data.sortBy).toBe(key);
  });

  const unlistedSortKeys = [
    ['display_name'],
    ['provider'],
    ['price'],
    ['ID'],
    ['id ASC'],
    ['created_at DESC'],
  ] as const;

  it.each(unlistedSortKeys)('rejects %p as a sort key', (key) => {
    // The MCP tool layer accepts a wider set of sort keys than this schema
    // does; that gap is real, and anything routing an MCP request through
    // PaginationSchema will be refused rather than silently sorted by id.
    const res = PaginationSchema.safeParse({ sortBy: key });
    expect(res.success).toBe(false);
    expect(res.success && res.data.sortBy).not.toBe('id');
  });

  it('accepts both sort directions and rejects anything else', () => {
    const asc = PaginationSchema.safeParse({ sortDir: 'asc' });
    expect(asc.success && asc.data.sortDir).toBe('asc');
    const desc = PaginationSchema.safeParse({ sortDir: 'desc' });
    expect(desc.success && desc.data.sortDir).toBe('desc');
    expect(PaginationSchema.safeParse({ sortDir: 'ASC' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ sortDir: 'ascending' }).success).toBe(false);
    expect(PaginationSchema.safeParse({ sortDir: '' }).success).toBe(false);
  });
});

// ── PaginationSchema: preprocessed boolean flags ─────────────────────────────

const booleanFlags = ['toolsOnly', 'reasoningOnly', 'availableOnly', 'retiredOnly'] as const;

describe.each(booleanFlags)('PaginationSchema %s', (flag) => {
  const truthy = [
    ['the string true', 'true'],
    ['the string 1', '1'],
    ['a real true', true],
  ] as const;

  it.each(truthy)('treats %s as enabled', (_label, value) => {
    const res = PaginationSchema.safeParse({ [flag]: value });
    expect(res.success).toBe(true);
    expect(res.success && res.data[flag]).toBe(true);
  });

  const falsy = [
    ['the string 0', '0'],
    ['the string false', 'false'],
    ['an uppercase TRUE', 'TRUE'],
    ['a mixed-case True', 'True'],
    ['the word yes', 'yes'],
    ['the word on', 'on'],
    ['an empty string', ''],
    ['the number 1', 1],
    ['a real false', false],
    ['null', null],
    ['an object', {}],
    ['an array', ['true']],
  ] as const;

  it.each(falsy)('silently treats %s as disabled instead of rejecting it', (_label, value) => {
    // The preprocess is lossy: anything that is not exactly 'true', '1' or
    // boolean true becomes false, so a caller sending ?toolsOnly=TRUE or
    // toolsOnly=1 (as a number) gets an unfiltered list back with no error to
    // tell them their filter was dropped.
    const res = PaginationSchema.safeParse({ [flag]: value });
    expect(res.success).toBe(true);
    expect(res.success && res.data[flag]).toBe(false);
    expect(res.success && res.data[flag]).not.toBe(true);
  });

  it('defaults to disabled whether the key is absent or explicitly undefined', () => {
    const absent = PaginationSchema.safeParse({});
    const explicit = PaginationSchema.safeParse({ [flag]: undefined });
    expect(absent.success && absent.data[flag]).toBe(false);
    expect(explicit.success && explicit.data[flag]).toBe(false);
    // The default is materialised, so a caller can read the flag without
    // needing to distinguish "absent" from "false".
    expect(absent.success && flag in absent.data).toBe(true);
  });
});

describe('PaginationSchema boolean flags together', () => {
  it('keeps the flags independent of one another', () => {
    const res = PaginationSchema.safeParse({ toolsOnly: 'true', retiredOnly: 'false' });
    expect(res.success && res.data.toolsOnly).toBe(true);
    expect(res.success && res.data.retiredOnly).toBe(false);
    expect(res.success && res.data.reasoningOnly).toBe(false);
    expect(res.success && res.data.availableOnly).toBe(false);
  });
});

// ── PaginationSchema: query and provider ─────────────────────────────────────

describe('PaginationSchema query and provider', () => {
  it('accepts a query of exactly 256 characters and rejects 257', () => {
    expect(PaginationSchema.safeParse({ query: 'a'.repeat(256) }).success).toBe(true);
    expect(PaginationSchema.safeParse({ query: 'a'.repeat(257) }).success).toBe(false);
  });

  it('rejects an over-long query rather than truncating it to the limit', () => {
    const res = PaginationSchema.safeParse({ query: 'a'.repeat(300) });
    expect(res.success).toBe(false);
    expect(res.success && res.data.query?.length).not.toBe(256);
  });

  it('accepts an empty query string, which is not the same as omitting it', () => {
    // There is no `.min(1)` here, so `?query=` arrives as a present-but-empty
    // filter; the search layer, not this schema, decides what that means.
    const res = PaginationSchema.safeParse({ query: '' });
    expect(res.success && res.data.query).toBe('');
    expect(res.success && 'query' in res.data).toBe(true);
  });

  it('does not constrain the provider string at all', () => {
    // Unlike ModelIdSchema, `provider` has no length or character restriction,
    // so it reaches the query layer verbatim and must be parameterised there.
    const res = PaginationSchema.safeParse({ provider: "anthropic'; --" });
    expect(res.success).toBe(true);
    expect(res.success && res.data.provider).toBe("anthropic'; --");
  });

  it('rejects a non-string provider or query without coercing it', () => {
    expect(PaginationSchema.safeParse({ provider: 1 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ query: 1 }).success).toBe(false);
  });
});
