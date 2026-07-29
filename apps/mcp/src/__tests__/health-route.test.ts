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
