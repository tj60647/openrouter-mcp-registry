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

export interface SyncHistoryEntry {
  id: number;
  syncedAt: Date;
  success: boolean;
  recordCount: number | null;
  error: string | null;
}

export interface SyncHistoryRow {
  id: number | string;
  synced_at: Date | string;
  success: boolean;
  record_count: number | string | null;
  error: string | null;
}

export function rowToSyncHistoryEntry(row: SyncHistoryRow): SyncHistoryEntry {
  return {
    id: typeof row.id === 'string' ? parseInt(row.id, 10) : row.id,
    syncedAt: new Date(row.synced_at),
    success: row.success,
    recordCount: row.record_count != null
      ? typeof row.record_count === 'string' ? parseInt(row.record_count, 10) : row.record_count
      : null,
    error: row.error ?? null,
  };
}
