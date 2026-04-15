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
