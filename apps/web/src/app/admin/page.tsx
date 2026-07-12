'use client';

import Link from 'next/link';
import AdminNav from '../../components/AdminNav';

export default function AdminDashboardPage() {
  return (
    <div className="stack">
      <AdminNav />
      <div>
        <h1>Admin</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Manage the model registry, see which agents are connected, and track usage.
        </p>
      </div>

      <div className="grid-3">
        <Link className="card" href="/admin/clients" style={{ textDecoration: 'none' }}>
          <h3>🔑 Clients</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            OAuth clients (coding agents) that have registered. Review and revoke access.
          </p>
        </Link>
        <Link className="card" href="/admin/usage" style={{ textDecoration: 'none' }}>
          <h3>📊 Usage</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Tool calls broken down by agent and by tool, over a time window.
          </p>
        </Link>
        <Link className="card" href="/admin/refresh" style={{ textDecoration: 'none' }}>
          <h3>↻ Sync</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Trigger a manual sync of the OpenRouter model catalog into the database.
          </p>
        </Link>
      </div>
    </div>
  );
}
