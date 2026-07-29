/**
 * @file health-route.test.ts
 * Tests for apps/mcp /api/health.
 *
 * The point of these is the status code, not the body. The failure path used to
 * answer HTTP 200 with `{ status: 'degraded' }`, so any monitor keyed on the
 * status — which is most of them — reported the service healthy while its
 * database was unreachable.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSyncStatus = vi.hoisted(() => vi.fn());

vi.mock('../lib/db', () => ({
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
}));

import { GET } from '../app/api/health/route';

describe('GET /api/health', () => {
  beforeEach(() => {
    mockGetSyncStatus.mockReset();
  });

  it('answers 200 with status ok when the registry is reachable', async () => {
    mockGetSyncStatus.mockResolvedValueOnce({
      lastSuccessfulSync: new Date('2026-07-29T00:00:48.813Z'),
      lastAttemptedSync: new Date('2026-07-29T00:00:48.813Z'),
      lastError: null,
      recordCount: 367,
    });

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; syncStatus: { recordCount: number } };
    expect(body.status).toBe('ok');
    expect(body.syncStatus.recordCount).toBe(367);
  });

  // ── Payload completeness ────────────────────────────────────────────────────
  // The route used to return only lastSuccessfulSync and recordCount. The
  // /sync-status page renders all four fields from this object, so the two it
  // dropped rendered as "Never" and "No errors" no matter what had happened —
  // a failing sync looked healthy on the page built to show sync failures.

  it('returns the whole sync status, not a subset of it', async () => {
    mockGetSyncStatus.mockResolvedValueOnce({
      lastSuccessfulSync: new Date('2026-07-28T00:00:48.555Z'),
      lastAttemptedSync: new Date('2026-07-29T00:00:46.754Z'),
      lastError: 'OpenRouter API error: 429 Too Many Requests',
      recordCount: 340,
    });

    const res = await GET();

    const body = (await res.json()) as { syncStatus: Record<string, unknown> };
    expect(Object.keys(body.syncStatus).sort()).toEqual([
      'lastAttemptedSync',
      'lastError',
      'lastSuccessfulSync',
      'recordCount',
    ]);
  });

  it('surfaces a failed sync rather than reporting no errors', async () => {
    mockGetSyncStatus.mockResolvedValueOnce({
      lastSuccessfulSync: new Date('2026-07-28T00:00:48.555Z'),
      lastAttemptedSync: new Date('2026-07-29T00:00:46.754Z'),
      lastError: 'OpenRouter API error: 429 Too Many Requests',
      recordCount: 340,
    });

    const res = await GET();

    const body = (await res.json()) as {
      syncStatus: { lastError: string | null; lastAttemptedSync: string | null };
    };
    // The defect in two assertions: both of these were absent, and the page
    // treats absent as "nothing wrong".
    expect(body.syncStatus.lastError).toBe('OpenRouter API error: 429 Too Many Requests');
    expect(body.syncStatus.lastAttemptedSync).not.toBeUndefined();
  });

  it('distinguishes an attempt that has never happened from one that never failed', async () => {
    mockGetSyncStatus.mockResolvedValueOnce({
      lastSuccessfulSync: null,
      lastAttemptedSync: null,
      lastError: null,
      recordCount: 0,
    });

    const res = await GET();

    const body = (await res.json()) as {
      syncStatus: { lastAttemptedSync: string | null; lastError: string | null };
    };
    // Present-and-null, not missing: the page renders null as "Never", which is
    // only correct when the field actually arrived.
    expect(body.syncStatus).toHaveProperty('lastAttemptedSync', null);
    expect(body.syncStatus).toHaveProperty('lastError', null);
  });

  it('answers 200 when the registry is reachable but has never synced', async () => {
    mockGetSyncStatus.mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; syncStatus: null };
    expect(body.status).toBe('ok');
    expect(body.syncStatus).toBeNull();
  });

  it('answers 503, not 200, when the database is unreachable', async () => {
    mockGetSyncStatus.mockRejectedValueOnce(new Error('connection refused'));

    const res = await GET();

    // The defect in one assertion.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(503);
  });

  it('reports the failure reason in the body of the 503', async () => {
    mockGetSyncStatus.mockRejectedValueOnce(new Error('connection refused'));

    const res = await GET();

    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe('degraded');
    expect(body.error).toContain('connection refused');
  });

  it('answers 503 when the failure is not an Error instance', async () => {
    mockGetSyncStatus.mockRejectedValueOnce('socket hang up');

    const res = await GET();

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unknown error');
  });
});
