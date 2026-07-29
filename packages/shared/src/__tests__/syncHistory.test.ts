import { describe, it, expect } from 'vitest';
import { rowToSyncHistoryEntry } from '../types/sync';
import type { SyncHistoryRow } from '../types/sync';

const makeRow = (overrides: Partial<SyncHistoryRow> = {}): SyncHistoryRow => ({
  id: 1,
  synced_at: '2026-07-29T00:00:46.754Z',
  status: 'success',
  success: true,
  record_count: 367,
  error: null,
  finished_at: '2026-07-29T00:00:48.813Z',
  partial: false,
  ...overrides,
});

describe('rowToSyncHistoryEntry', () => {
  it('maps a finished successful attempt', () => {
    const entry = rowToSyncHistoryEntry(makeRow());
    expect(entry.status).toBe('success');
    expect(entry.success).toBe(true);
    expect(entry.recordCount).toBe(367);
    expect(entry.finishedAt).toEqual(new Date('2026-07-29T00:00:48.813Z'));
  });

  it('maps a finished failed attempt', () => {
    const entry = rowToSyncHistoryEntry(
      makeRow({ status: 'failure', success: false, record_count: null, error: 'timeout' })
    );
    expect(entry.status).toBe('failure');
    expect(entry.success).toBe(false);
    expect(entry.error).toBe('timeout');
  });

  it('reports a running attempt as neither success nor failure', () => {
    const entry = rowToSyncHistoryEntry(
      makeRow({ status: 'running', success: null, record_count: null, error: null, finished_at: null })
    );
    expect(entry.status).toBe('running');
    // The whole point of the lifecycle: an in-flight attempt has no verdict, so
    // a monitor counting `success === false` rows cannot mistake it for an outage.
    expect(entry.success).toBeNull();
    expect(entry.success).not.toBe(false);
    expect(entry.finishedAt).toBeNull();
  });

  it('never reports a finishedAt for a running attempt', () => {
    // A row can carry a stale finished_at if an old attempt was reopened; the
    // reader must not present a completion time for something still running.
    const entry = rowToSyncHistoryEntry(
      makeRow({ status: 'running', success: null, finished_at: '2026-07-29T00:00:48.813Z' })
    );
    expect(entry.finishedAt).toBeNull();
  });

  // ── Rows written before the status column existed ──────────────────────────

  it('classifies a legacy start marker as running, not as a failure', () => {
    // The exact shape the old two-row writer emitted before every sync.
    const entry = rowToSyncHistoryEntry(
      makeRow({ status: null, success: false, record_count: null, error: null, finished_at: null })
    );
    expect(entry.status).toBe('running');
    expect(entry.success).not.toBe(false);
    expect(entry.success).toBeNull();
  });

  it('classifies a legacy failure with an error message as a failure', () => {
    const entry = rowToSyncHistoryEntry(
      makeRow({ status: null, success: false, record_count: null, error: 'network error' })
    );
    expect(entry.status).toBe('failure');
    expect(entry.success).toBe(false);
  });

  it('classifies a legacy success as a success', () => {
    const entry = rowToSyncHistoryEntry(
      makeRow({ status: null, success: true, record_count: 340, finished_at: null })
    );
    expect(entry.status).toBe('success');
    expect(entry.success).toBe(true);
    expect(entry.recordCount).toBe(340);
  });

  it('ignores an unrecognised status string and falls back to the success flag', () => {
    const entry = rowToSyncHistoryEntry(makeRow({ status: 'bogus', success: true }));
    expect(entry.status).toBe('success');
  });

  it('parses bigint ids and numeric counts returned as strings', () => {
    const entry = rowToSyncHistoryEntry(makeRow({ id: '56', record_count: '367' }));
    expect(entry.id).toBe(56);
    expect(entry.recordCount).toBe(367);
  });
});
