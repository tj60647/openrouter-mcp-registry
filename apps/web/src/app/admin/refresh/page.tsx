'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function AdminRefreshPage() {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function triggerRefresh() {
    setRefreshing(true);
    setRefreshResult(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) throw new Error(String(json['error'] ?? 'Unknown error'));
      setRefreshResult(JSON.stringify(json, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    router.push('/admin/login');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void triggerRefresh();
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Admin Refresh</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Manually trigger a model catalog sync from OpenRouter.
          </p>
        </div>
        <button
          onClick={() => { void handleLogout(); }}
          style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', marginTop: '0.25rem' }}
        >
          Sign out
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="card">
        <h3>Manual Refresh</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Trigger a manual sync from OpenRouter.
        </p>
        <form className="stack" style={{ marginTop: '1rem' }} onSubmit={handleSubmit}>
          <button type="submit" disabled={refreshing} style={{ maxWidth: 200 }}>
            {refreshing ? 'Syncing...' : '↻ Trigger Refresh'}
          </button>
          {refreshResult && (
            <pre style={{ fontSize: '0.8rem' }}>{refreshResult}</pre>
          )}
        </form>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
        <Link href="/sync-status">← View Sync Status</Link>
      </p>
    </div>
  );
}
