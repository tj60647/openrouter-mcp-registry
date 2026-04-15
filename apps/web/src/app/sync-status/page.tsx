'use client';

import { useEffect, useState } from 'react';
import type { SyncStatus } from '@openrouter-mcp/shared';

interface SyncStatusResponse {
  status: SyncStatus | null;
}

export default function SyncStatusPage() {
  const [data, setData] = useState<SyncStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adminToken, setAdminToken] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);

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

  async function triggerRefresh() {
    if (!adminToken) {
      setRefreshResult('Admin token required');
      return;
    }
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const res = await fetch('/api/admin/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json['error'] ?? 'Unknown error'));
      setRefreshResult(JSON.stringify(json, null, 2));
      await fetchStatus();
    } catch (e) {
      setRefreshResult(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { fetchStatus(); }, []);

  function formatDate(d: Date | string | null) {
    if (!d) return 'Never';
    return new Date(d).toLocaleString();
  }

  return (
    <div className="stack">
      <div>
        <h1>Sync Status</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Current state of the model catalog sync from OpenRouter.
        </p>
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

      <div className="card">
        <h3>Manual Refresh</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Trigger a manual sync from OpenRouter. Requires admin token.
        </p>
        <div className="stack" style={{ marginTop: '1rem' }}>
          <input
            type="password"
            placeholder="Admin token (ADMIN_SECRET env var)"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            style={{ maxWidth: 400 }}
          />
          <button
            onClick={triggerRefresh}
            disabled={refreshing}
            style={{ maxWidth: 200 }}
          >
            {refreshing ? 'Syncing...' : '↻ Trigger Refresh'}
          </button>
          {refreshResult && (
            <pre style={{ fontSize: '0.8rem' }}>{refreshResult}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
