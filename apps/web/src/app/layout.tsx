import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import NavBar from '../components/NavBar';

// The studio loads Inter at 300..700; we need 400 (body), 600 (buttons) and
// 700 (every bold uppercase label). `--font-inter` is consumed by `--font`
// in globals.css, which keeps the system fallback stack behind it.
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'OpenRouter Registry MCP',
  description: 'A centralized MCP model registry backed by OpenRouter',
  icons: { icon: '/icon.svg', shortcut: '/icon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <NavBar />
        <main>
          <div className="container">{children}</div>
        </main>
      </body>
    </html>
  );
}
