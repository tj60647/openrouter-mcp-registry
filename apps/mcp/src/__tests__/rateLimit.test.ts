/**
 * @file rateLimit.test.ts
 * Tests for the Postgres-backed limiter in apps/mcp.
 *
 * The property that matters is that the counter is NOT in process memory: it
 * used to be a module-level Map, so on Vercel "5 per 15 minutes" meant 5 per 15
 * minutes per warm lambda and reset on every cold start.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockQuery, mockSql } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('@vercel/postgres', () => ({
  sql: mockSql,
  db: { query: mockQuery },
}));

import { checkRateLimit, clearRateLimit, resetPruneScheduleForTests } from '../lib/rateLimit';

const OPTS = { limit: 5, windowMs: 15 * 60_000 };

/** The limiter returns the post-increment count for the key. */
function counted(n: number) {
  return { rows: [{ count: String(n) }] };
}

describe('checkRateLimit', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    resetPruneScheduleForTests();
  });

  it('allows a request while the count is within the limit', async () => {
    mockQuery.mockResolvedValueOnce(counted(1));
    await expect(checkRateLimit('k', OPTS)).resolves.toBe(true);
  });

  it('allows the request that exactly reaches the limit', async () => {
    mockQuery.mockResolvedValueOnce(counted(5));
    await expect(checkRateLimit('k', OPTS)).resolves.toBe(true);
  });

  it('denies the request that exceeds the limit', async () => {
    mockQuery.mockResolvedValueOnce(counted(6));
    await expect(checkRateLimit('k', OPTS)).resolves.toBe(false);
  });

  // ── The defect ─────────────────────────────────────────────────────────────

  it('does not keep the counter in process memory', async () => {
    mockQuery.mockResolvedValue(counted(1));

    await checkRateLimit('k', OPTS);
    await checkRateLimit('k', OPTS);

    // Every decision is a round trip to the shared store. A module-level Map
    // would have answered the second call without touching the database, which
    // is exactly why the limit was per-lambda.
    const increments = mockQuery.mock.calls.filter(([sql]) =>
      (sql as string).includes('INSERT INTO rate_limits')
    );
    expect(increments).toHaveLength(2);
  });

  it('checks and increments in a single statement', async () => {
    mockQuery.mockResolvedValueOnce(counted(1));

    await checkRateLimit('k', OPTS);

    // A read-then-write pair would let two concurrent instances both observe
    // the same pre-increment count and both allow the request.
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO rate_limits');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('RETURNING');
    expect(sql).not.toMatch(/^\s*SELECT/i);
  });

  it('passes the key and window to the store', async () => {
    mockQuery.mockResolvedValueOnce(counted(1));

    await checkRateLimit('oauth:register:1.2.3.4', OPTS);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['oauth:register:1.2.3.4', 15 * 60_000]);
  });

  it('resets the window once it has elapsed rather than counting forever', async () => {
    mockQuery.mockResolvedValueOnce(counted(1));

    await checkRateLimit('k', OPTS);

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('window_start = CASE');
    expect(sql).toContain("INTERVAL '1 millisecond'");
  });

  // ── Failure behaviour ──────────────────────────────────────────────────────

  it('fails closed when the store is unreachable', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    // Failing open here would drop brute-force protection at precisely the
    // moment the database is unhealthy.
    await expect(checkRateLimit('k', OPTS)).resolves.toBe(false);
  });

  it('fails open, loudly, when the table has not been migrated yet', async () => {
    // Migrations are a manual step, so deploying this code before running them
    // is a realistic mistake. Failing closed on it would take every OAuth
    // endpoint and every MCP tool call down at once.
    const err = Object.assign(new Error('relation "rate_limits" does not exist'), { code: '42P01' });
    mockQuery.mockRejectedValueOnce(err);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkRateLimit('k', OPTS)).resolves.toBe(true);
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0]?.[0])).toContain('rate_limits');

    logged.mockRestore();
  });

  it('recognises the missing table from the message when no code is attached', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "rate_limits" does not exist'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkRateLimit('k', OPTS)).resolves.toBe(true);

    logged.mockRestore();
  });

  it('does not treat an unrelated missing relation as its own provisioning gap', async () => {
    // A bare undefined-table message naming a different relation is not the
    // carve-out. (An SQLSTATE 42P01 raised by this function can only ever be
    // about rate_limits, since that is the only table it queries — so the code
    // check alone is sound; this pins the message-only path.)
    mockQuery.mockRejectedValueOnce(new Error('relation "models" does not exist'));

    await expect(checkRateLimit('k', OPTS)).resolves.toBe(false);
  });

  it('fails closed when the store returns nothing usable', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(checkRateLimit('k', OPTS)).resolves.toBe(false);

    mockQuery.mockResolvedValueOnce({ rows: [{ count: 'not-a-number' }] });
    await expect(checkRateLimit('k', OPTS)).resolves.toBe(false);
  });

  it('keeps separate keys independent', async () => {
    // Default covers the housekeeping DELETE that the first call also triggers.
    mockQuery.mockResolvedValue(counted(1));
    mockQuery.mockResolvedValueOnce(counted(6));

    await expect(checkRateLimit('a', OPTS)).resolves.toBe(false);
    await expect(checkRateLimit('b', OPTS)).resolves.toBe(true);
  });

  // ── Housekeeping ───────────────────────────────────────────────────────────

  it('prunes expired windows at most once per interval', async () => {
    mockQuery.mockResolvedValue(counted(1));

    await checkRateLimit('k', OPTS);
    await checkRateLimit('k', OPTS);
    await checkRateLimit('k', OPTS);

    const prunes = mockQuery.mock.calls.filter(([sql]) =>
      (sql as string).includes('DELETE FROM rate_limits')
    );
    expect(prunes).toHaveLength(1);
  });

  it('still allows the request when pruning fails', async () => {
    mockQuery
      .mockResolvedValueOnce(counted(1))
      .mockRejectedValueOnce(new Error('deadlock detected'));

    await expect(checkRateLimit('k', OPTS)).resolves.toBe(true);
  });
});

// ── clearRateLimit ────────────────────────────────────────────────────────────

describe('clearRateLimit', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    resetPruneScheduleForTests();
  });

  it('deletes only the counter for the given key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await clearRateLimit('admin:verify-login:admin:1.2.3.4');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM rate_limits');
    expect(sql).toContain('WHERE key = $1');
    expect(params).toEqual(['admin:verify-login:admin:1.2.3.4']);
  });

  it('swallows a failure rather than breaking the caller', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    // Leaving the counter in place is the safe direction: worst case the window
    // expires on its own.
    await expect(clearRateLimit('k')).resolves.toBeUndefined();
  });
});
