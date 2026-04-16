'use client';

import { useEffect, useState } from 'react';
import type { SyncStatus } from '@openrouter-mcp/shared';
import Link from 'next/link';

interface SyncStatusResponse {
  status: SyncStatus | null;
}

export default function SyncStatusPage() {
  const [data, setData] = useState<SyncStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchStatus() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { syncStatus: SyncStatus | null };
      setData({ status: json.syncStatus });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void fetchStatus(); }, []);

  function formatDate(d: Date | string | null) {
    if (!d) return 'Never';
    return new Date(d).toLocaleString();
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Sync Status</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Current state of the model catalog sync from OpenRouter.
          </p>
        </div>
        <Link href="/admin/refresh" style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
          Admin Refresh →
        </Link>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading sync status...</div>}

      {!loading && data && (
        <div className="grid-2">
          <div className="card">
            <h3>Registry Statistics</h3>
            <div className="stack" style={{ marginTop: '1rem', gap: '0.75rem' }}>
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Cached Models</p>
                <p style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>
                  {data.status?.recordCount ?? 0}
                </p>
              </div>
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Last Successful Sync</p>
                <p style={{ margin: 0 }}>{formatDate(data.status?.lastSuccessfulSync ?? null)}</p>
              </div>
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Last Attempted Sync</p>
                <p style={{ margin: 0 }}>{formatDate(data.status?.lastAttemptedSync ?? null)}</p>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>Last Error</h3>
            <div style={{ marginTop: '1rem' }}>
              {data.status?.lastError ? (
                <div className="error-msg">{data.status.lastError}</div>
              ) : (
                <span className="badge badge-success">No errors</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
