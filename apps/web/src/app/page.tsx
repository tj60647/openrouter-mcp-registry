import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="stack" style={{ gap: '2.5rem', marginTop: '1rem' }}>
      <div>
        <h1>OpenRouter MCP Registry</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', marginBottom: 0 }}>
          A centralized model registry backed by OpenRouter. Prevents stale model names,
          standardizes model IDs, and exposes an MCP-compatible endpoint for AI clients.
        </p>
      </div>

      <div className="grid-3">
        <div className="card">
          <h3>🗂 Model Registry</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Browse all cached models fetched from OpenRouter. Filter by provider, view pricing and context length.
          </p>
          <Link href="/models">Browse Models →</Link>
        </div>
        <div className="card">
          <h3>🔍 Model Resolution</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Resolve any alias (sonnet, gpt-4o) or canonical ID to the exact model. Never worry about stale names again.
          </p>
          <Link href="/resolve">Try Resolver →</Link>
        </div>
        <div className="card">
          <h3>🔌 MCP Protocol</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Connect AI coding assistants and agents directly to this registry using the Model Context Protocol.
          </p>
          <Link href="/mcp-info">MCP Setup →</Link>
        </div>
      </div>

      <div className="card">
        <h2>Architecture</h2>
        <pre>{`
┌─────────────────────────────────────────────────────────────┐
│                     Vercel Deployment                        │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  apps/web    │    │  apps/mcp    │    │  packages/   │  │
│  │  (Next.js)   │───▶│  (Next.js)   │───▶│  shared      │  │
│  │  Demo UI     │    │  MCP Server  │    │  Types+Svc   │  │
│  └──────────────┘    └──────┬───────┘    └──────────────┘  │
│                             │                               │
│                    ┌────────▼────────┐                      │
│                    │  Vercel Postgres │                      │
│                    │  models         │                      │
│                    │  aliases        │                      │
│                    │  sync_status    │                      │
│                    └─────────────────┘                      │
│                                                             │
│  Cron (weekly) ──▶ /api/cron/sync ──▶ OpenRouter API        │
└─────────────────────────────────────────────────────────────┘
        `.trim()}</pre>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Supported Aliases</h3>
          <table>
            <thead>
              <tr><th>Alias</th><th>Resolves To</th></tr>
            </thead>
            <tbody>
              {[
                ['auto', 'openrouter/auto'],
                ['sonnet', 'anthropic/claude-sonnet-4-5'],
                ['haiku', 'anthropic/claude-haiku-4-5'],
                ['fast-general', 'anthropic/claude-haiku-4-5'],
                ['best-general', 'anthropic/claude-sonnet-4-5'],
                ['gpt-4o', 'openai/gpt-4o'],
                ['gemini', 'google/gemini-pro-1.5'],
                ['mistral', 'mistralai/mistral-large'],
              ].map(([alias, model]) => (
                <tr key={alias}>
                  <td><code>{alias}</code></td>
                  <td><code style={{ color: 'var(--text-muted)' }}>{model}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Quick Start</h3>
          <div className="stack" style={{ gap: '0.75rem' }}>
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.3rem' }}>List models</p>
              <pre><code>GET /api/models</code></pre>
            </div>
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.3rem' }}>Resolve alias</p>
              <pre><code>POST /api/resolve{'\n'}{'{"input":"sonnet"}'}</code></pre>
            </div>
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.3rem' }}>MCP endpoint</p>
              <pre><code>POST /api/mcp</code></pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
