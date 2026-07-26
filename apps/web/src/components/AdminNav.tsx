'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const links = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/clients', label: 'Clients' },
  { href: '/admin/usage', label: 'Usage' },
  { href: '/admin/refresh', label: 'Sync' },
];

export default function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/admin/session')
      .then(async (r) => {
        if (r.ok && active) {
          const j = (await r.json()) as { username?: string };
          setUsername(j.username ?? null);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function logout() {
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    router.push('/admin/login');
    router.refresh();
  }

  return (
    <div
      className="row"
      style={{
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        paddingBottom: '0.75rem',
        marginBottom: '0.5rem',
        flexWrap: 'wrap',
        gap: '0.75rem',
      }}
    >
      <div className="row" style={{ gap: '0.375rem', flexWrap: 'wrap' }}>
        {links.map((l) => {
          const isActive = l.href === '/admin' ? pathname === '/admin' : pathname.startsWith(l.href);
          return (
            // Bordered tab pair (studio AdminLayout.tsx:128-132). Weight alone
            // no longer differentiates the active tab now that every link is black.
            <Link
              key={l.href}
              href={l.href}
              className={isActive ? 'btn-ghost active' : 'btn-ghost'}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
      <div className="row" style={{ gap: '0.75rem', alignItems: 'center' }}>
        {username && (
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Signed in as <strong style={{ color: 'var(--text)' }}>{username}</strong>
          </span>
        )}
        <button className="btn-ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
