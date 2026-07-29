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

import { checkRateLimit, resetPruneScheduleForTests } from '../lib/rateLimit';

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
