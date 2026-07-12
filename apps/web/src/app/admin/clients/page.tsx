'use client';

import { useCallback, useEffect, useState } from 'react';
import AdminNav from '../../../components/AdminNav';

interface ClientView {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scope: string;
  tokenEndpointAuthMethod: string;
  createdAt: string;
  revokedAt: string | null;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function AdminClientsPage() {
  const [clients, setClients] = useState<ClientView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/clients');
      const json = (await res.json()) as { clients?: ClientView[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Failed to load clients');
      setClients(json.clients ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load clients');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleRevoke(clientId: string, revoke: boolean) {
    setBusy(clientId);
    setError(null);
    try {
      const res = await fetch('/api/admin/clients/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, action: revoke ? 'revoke' : 'unrevoke' }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Action failed');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <AdminNav />
      <div>
        <h1>Registered Clients</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          OAuth clients — coding agents like Claude Code, Cursor, or Copilot — that have registered
          with this MCP server. Revoking a client immediately blocks it from obtaining new access
          tokens (existing tokens expire within an hour).
        </p>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {!clients ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : clients.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>
            No clients have registered yet. When you connect a coding agent to{' '}
            <code>/api/mcp</code> via OAuth, it will appear here.
          </p>
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Client ID</th>
                <th>Scope</th>
                <th>Registered</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => {
                const revoked = c.revokedAt !== null;
                return (
                  <tr key={c.clientId} style={revoked ? { opacity: 0.55 } : undefined}>
                    <td>{c.clientName}</td>
                    <td>
                      <code style={{ fontSize: '0.8rem' }}>{c.clientId.slice(0, 12)}…</code>
                    </td>
                    <td>{c.scope}</td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: '0.85rem' }}>{fmtDate(c.createdAt)}</td>
                    <td>
                      {revoked ? (
                        <span className="badge" style={{ color: 'var(--error)', borderColor: 'var(--error)' }}>
                          Revoked
                        </span>
                      ) : (
                        <span className="badge" style={{ color: 'var(--success)', borderColor: 'var(--success)' }}>
                          Active
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        disabled={busy === c.clientId}
                        onClick={() => void toggleRevoke(c.clientId, !revoked)}
                        style={
                          revoked
                            ? { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' }
                            : { background: 'transparent', border: '1px solid var(--error)', color: 'var(--error)' }
                        }
                      >
                        {busy === c.clientId ? '…' : revoked ? 'Restore' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
