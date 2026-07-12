'use client';

import { useCallback, useEffect, useState } from 'react';
import AdminNav from '../../../components/AdminNav';

interface UsageByClient {
  clientId: string;
  clientName: string | null;
  totalCalls: number;
  errorCalls: number;
  lastCalledAt: string | null;
}
interface UsageByTool {
  tool: string;
  totalCalls: number;
}
interface UsageReport {
  totalCalls: number;
  windowDays: number;
  byClient: UsageByClient[];
  byTool: UsageByTool[];
}

const WINDOWS = [7, 30, 90];

export default function AdminUsagePage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (windowDays: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/usage?days=${windowDays}`);
      const json = (await res.json()) as UsageReport & { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Failed to load usage');
      setReport(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage');
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  return (
    <div className="stack">
      <AdminNav />
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1>Usage</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            MCP tool calls attributed to each client (agent), over the selected window.
          </p>
        </div>
        <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              style={
                days === w
                  ? { background: 'var(--accent)', color: '#fff' }
                  : { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }
              }
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {!report ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : (
        <>
          <div className="card">
            <p style={{ margin: 0 }}>
              <strong style={{ fontSize: '1.6rem' }}>{report.totalCalls.toLocaleString()}</strong>{' '}
              <span style={{ color: 'var(--text-muted)' }}>tool calls in the last {report.windowDays} days</span>
            </p>
          </div>

          <div>
            <h3>By agent</h3>
            {report.byClient.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No usage recorded in this window yet.</p>
            ) : (
              <div className="card" style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Agent / client</th>
                      <th>Client ID</th>
                      <th style={{ textAlign: 'right' }}>Calls</th>
                      <th style={{ textAlign: 'right' }}>Errors</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byClient.map((c) => (
                      <tr key={c.clientId}>
                        <td>{c.clientName ?? <span style={{ color: 'var(--text-muted)' }}>Unknown</span>}</td>
                        <td><code style={{ fontSize: '0.8rem' }}>{c.clientId.slice(0, 12)}…</code></td>
                        <td style={{ textAlign: 'right' }}>{c.totalCalls.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: c.errorCalls > 0 ? 'var(--warning)' : 'inherit' }}>
                          {c.errorCalls}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>
                          {c.lastCalledAt ? new Date(c.lastCalledAt).toLocaleString() : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h3>By tool</h3>
            {report.byTool.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No usage recorded in this window yet.</p>
            ) : (
              <div className="card" style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th style={{ textAlign: 'right' }}>Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byTool.map((t) => (
                      <tr key={t.tool}>
                        <td><code style={{ fontSize: '0.85rem' }}>{t.tool}</code></td>
                        <td style={{ textAlign: 'right' }}>{t.totalCalls.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
