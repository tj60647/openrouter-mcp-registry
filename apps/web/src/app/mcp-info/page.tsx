export default function McpInfoPage() {
  const baseUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://your-app.vercel.app';

  return (
    <div className="stack">
      <div>
        <h1>MCP Integration</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Connect any AI client that supports the Model Context Protocol (MCP) to this registry.
        </p>
      </div>

      <div className="card">
        <h2>Endpoint</h2>
        <pre><code>POST {baseUrl}/api/mcp</code></pre>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          If <code>MCP_API_KEY</code> is configured, pass it as a Bearer token in the Authorization header.
        </p>
      </div>

      <div className="card">
        <h2>Available Tools</h2>
        <div className="stack">
          {[
            {
              name: 'list_models',
              description: 'List all models in the registry',
              params: '{ limit?: number, offset?: number, provider?: string }',
            },
            {
              name: 'resolve_model',
              description: 'Resolve an alias or ID to its canonical form',
              params: '{ input: string }',
            },
            {
              name: 'get_default_model',
              description: 'Get the default recommended model',
              params: '{}',
            },
            {
              name: 'get_sync_status',
              description: 'Get the current sync status',
              params: '{}',
            },
          ].map((tool) => (
            <div key={tool.name} className="card" style={{ background: 'var(--bg)' }}>
              <code style={{ fontSize: '1rem', color: 'var(--accent)' }}>{tool.name}</code>
              <p style={{ margin: '0.4rem 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{tool.description}</p>
              <pre><code>{tool.params}</code></pre>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Claude Desktop Configuration</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Add this to your Claude Desktop MCP configuration:
        </p>
        <pre><code>{JSON.stringify(
          {
            mcpServers: {
              'openrouter-registry': {
                url: `${baseUrl}/api/mcp`,
                transport: 'streamable-http',
              },
            },
          },
          null,
          2
        )}</code></pre>
      </div>

      <div className="card">
        <h2>Usage Examples</h2>
        <div className="stack">
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Resolve a model alias in your agent:
            </p>
            <pre><code>{`// In your agent/assistant:
const result = await mcp.callTool('resolve_model', { input: 'sonnet' });
// → { resolved: 'anthropic/claude-sonnet-4-5', source: 'alias', found: true }`}</code></pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Get the default model:
            </p>
            <pre><code>{`const result = await mcp.callTool('get_default_model', {});
// → { resolved: 'anthropic/claude-sonnet-4-5', ... }`}</code></pre>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Cron Sync</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          The registry is automatically refreshed weekly via Vercel Cron:
        </p>
        <pre><code>{`// vercel.json
{
  "crons": [
    {
      "path": "/api/cron/sync",
      "schedule": "0 0 * * 0"
    }
  ]
}`}</code></pre>
      </div>
    </div>
  );
}
