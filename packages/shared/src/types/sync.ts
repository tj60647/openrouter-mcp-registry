export interface SyncStatus {
  lastSuccessfulSync: Date | null;
  lastAttemptedSync: Date | null;
  lastError: string | null;
  recordCount: number;
}

export interface SyncStatusRow {
  id: number;
  last_successful_sync: Date | null;
  last_attempted_sync: Date | null;
  last_error: string | null;
  record_count: number;
}

export function rowToSyncStatus(row: SyncStatusRow): SyncStatus {
  return {
    lastSuccessfulSync: row.last_successful_sync,
    lastAttemptedSync: row.last_attempted_sync,
    lastError: row.last_error,
    recordCount: row.record_count,
  };
}

/**
 * Lifecycle state of a single sync attempt.
 *
 * A row is inserted as `running` when the attempt starts and the *same row* is
 * updated in place when it finishes. A `running` row is therefore an attempt
 * that is either still in flight or whose process died before it could be
 * finalised — it is explicitly **not** a failure.
 */
export type SyncAttemptStatus = 'running' | 'success' | 'failure';

export interface SyncHistoryEntry {
  id: number;
  /** When the attempt started. Never rewritten, so history ordering is stable. */
  syncedAt: Date;
  status: SyncAttemptStatus;
  /** `null` while the attempt is still `running`; a boolean once it finishes. */
  success: boolean | null;
  recordCount: number | null;
  error: string | null;
  /** `null` while the attempt is still `running`. */
  finishedAt: Date | null;
}

export interface SyncHistoryRow {
  id: number | string;
  synced_at: Date | string;
  status: string | null;
  success: boolean | null;
  record_count: number | string | null;
  error: string | null;
  finished_at: Date | string | null;
}

/**
 * Derives the lifecycle status for rows written before the `status` column
 * existed. Those rows only carry `success`, so a legacy start marker
 * (`success = false` with neither an error nor a record count) is reported as
 * `running` rather than being mislabelled a failure.
 */
function deriveStatus(row: SyncHistoryRow): SyncAttemptStatus {
  if (row.status === 'running' || row.status === 'success' || row.status === 'failure') {
    return row.status;
  }
  if (row.success === true) return 'success';
  if (row.success === false && row.error == null && row.record_count == null) return 'running';
  return 'failure';
}

export function rowToSyncHistoryEntry(row: SyncHistoryRow): SyncHistoryEntry {
  const status = deriveStatus(row);
  return {
    id: typeof row.id === 'string' ? parseInt(row.id, 10) : row.id,
    syncedAt: new Date(row.synced_at),
    status,
    success: status === 'running' ? null : status === 'success',
    recordCount: row.record_count != null
      ? typeof row.record_count === 'string' ? parseInt(row.record_count, 10) : row.record_count
      : null,
    error: row.error ?? null,
    finishedAt: status === 'running' || row.finished_at == null ? null : new Date(row.finished_at),
  };
}
