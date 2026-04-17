import Link from 'next/link';
import MermaidDiagram from '../components/MermaidDiagram';

const architectureChart = `
flowchart LR
  subgraph Web["Vercel Deployment: web"]
    WebApp["apps/web<br/>Next.js demo UI"]
  end

  subgraph Mcp["Vercel Deployment: mcp"]
    McpApp["apps/mcp<br/>Next.js MCP + REST"]
    Database[("Vercel Postgres<br/>models<br/>sync_status")]
    Cron["Scheduled sync job"]
  end

  Shared["packages/shared<br/>types + services"]
  OpenRouter["OpenRouter API"]
  Clients["AI clients / coding agents"]

  Shared --> WebApp
  Shared --> McpApp
  WebApp --> Database
  McpApp --> Database
  Clients --> McpApp
  Cron --> OpenRouter
  OpenRouter --> Cron
  Cron --> Database
`.trim();

export default function HomePage() {
  const mcpUrl = process.env['NEXT_PUBLIC_MCP_URL'] ?? 'https://your-mcp-app.vercel.app';

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
            Resolve any canonical model ID to the exact registered model. Never worry about stale names again.
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
        <MermaidDiagram chart={architectureChart} title="OpenRouter MCP registry architecture" />
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Quick Start</h3>
          <div className="stack" style={{ gap: '0.75rem' }}>
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.3rem' }}>List models</p>
              <pre><code>GET /api/models</code></pre>
            </div>
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.3rem' }}>Resolve model ID</p>
              <pre><code>POST /api/resolve{'\n'}{'{"input":"anthropic/claude-sonnet-4-5"}'}</code></pre>
            </div>
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.3rem' }}>MCP endpoint (separate deployment)</p>
              <pre><code>POST {mcpUrl}/api/mcp</code></pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
