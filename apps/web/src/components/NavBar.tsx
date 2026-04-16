'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/', label: 'Home' },
  { href: '/models', label: 'Models' },
  { href: '/resolve', label: 'Resolve' },
  { href: '/sync-status', label: 'Sync Status' },
  { href: '/mcp-info', label: 'MCP Info' },
];

export default function NavBar() {
  const pathname = usePathname();
  return (
    <nav>
      <div className="nav-inner">
        <Link href="/" className="brand">🔄 MCP Registry</Link>
        <ul className="links">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={pathname === link.href ? 'active' : ''}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
