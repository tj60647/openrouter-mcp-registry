import './globals.css';
import type { Metadata } from 'next';
import NavBar from '../components/NavBar';

export const metadata: Metadata = {
  title: 'OpenRouter MCP Registry',
  description: 'A centralized MCP model registry backed by OpenRouter',
  icons: { icon: '/icon.svg', shortcut: '/icon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavBar />
        <main>
          <div className="container">{children}</div>
        </main>
      </body>
    </html>
  );
}
