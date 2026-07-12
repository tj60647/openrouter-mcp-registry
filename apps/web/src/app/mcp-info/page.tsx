export default function McpInfoPage() {
  const baseUrl = process.env['NEXT_PUBLIC_MCP_URL'] ?? 'https://your-mcp-app.vercel.app';

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
        <pre>
          <code>POST {baseUrl}/api/mcp</code>
        </pre>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          The endpoint speaks MCP over Streamable HTTP and, in production, is protected by OAuth
          2.1.
        </p>
      </div>

      <div className="card">
        <h2>Authentication</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          <strong style={{ color: 'var(--text)' }}>Interactive clients</strong> (Claude Code,
          Cursor, VS Code, Claude Desktop) authenticate automatically — you don&apos;t need to
          create or paste a token. On first use the server replies with a{' '}
          <code>401</code> that points to its OAuth metadata; the client registers itself via
          dynamic client registration, opens a browser to authorize (authorization code + PKCE),
          and stores the resulting token. Because this registry serves public model data, the
          authorization step is auto-approved, so the browser tab simply flashes and returns.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.6rem' }}>
          <strong style={{ color: 'var(--text)' }}>Server-side services</strong> can instead use the
          OAuth client-credentials grant: exchange <code>MCP_CLIENT_ID</code> and{' '}
          <code>MCP_CLIENT_SECRET</code> at <code>/api/oauth/token</code> for a short-lived{' '}
          <code>mcp:read</code> access token. Never expose those credentials in browser code.
        </p>
      </div>

      <div className="card">
        <h2>Available Tools</h2>
        <div className="stack">
          {[
            {
              name: 'list_models',
              description: 'List all models in the registry with optional filtering and sorting.',
              params:
                '{ limit?: number, offset?: number, provider?: string, query?: string, sortBy?: string, sortDir?: "asc"|"desc", availableOnly?: boolean }',
            },
            {
              name: 'resolve_model',
              description: 'Resolve a model ID to its canonical form and fetch its details',
              params: '{ input: string }',
            },
            {
              name: 'get_model',
              description: 'Get full details for a single model by canonical ID',
              params: '{ id: string }',
            },
            {
              name: 'search_models',
              description: 'Search models by name, ID, or provider substring',
              params:
                '{ query: string, limit?: number, offset?: number, sortBy?: string, sortDir?: "asc"|"desc" }',
            },
            {
              name: 'find_models_by_criteria',
              description: 'Filter models by budget, context, and modality constraints',
              params:
                '{ maxInputPricePer1k?: number, maxOutputPricePer1k?: number, minContextLength?: number, modality?: string, limit?: number, offset?: number, sortBy?: string, sortDir?: "asc"|"desc" }',
            },
            {
              name: 'compare_models',
              description:
                'Compare 2–5 models side-by-side on pricing, context length, and metadata',
              params: '{ ids: string[] }',
            },
            {
              name: 'semantic_search',
              description:
                'Find models by semantic similarity to a natural language description. Powered by openai/text-embedding-3-small via OpenRouter.',
              params: '{ query: string, limit?: number, offset?: number }',
            },
            {
              name: 'get_registry_status',
              description:
                'Get the current sync status of the model registry (last sync time, record count, errors)',
              params: '{}',
            },
            {
              name: 'get_sync_history',
              description:
                'Get the history of sync attempts (most recent first), including success/failure, record count, and any error messages',
              params: '{ limit?: number }',
            },
          ].map((tool) => (
            <div key={tool.name} className="card" style={{ background: 'var(--bg)' }}>
              <code style={{ fontSize: '1rem', color: 'var(--accent)' }}>{tool.name}</code>
              <p style={{ margin: '0.4rem 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                {tool.description}
              </p>
              <pre>
                <code>{tool.params}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Available Resources</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Read registry data directly via MCP resource URIs (read-only, accessible via{' '}
          <code>resources/read</code>).
        </p>
        <div className="stack">
          {[
            {
              uri: 'registry://models',
              description: 'Full list of models in the registry (up to 500)',
            },
            {
              uri: 'registry://status',
              description: 'Current sync status (last sync time, record count, errors)',
            },
            {
              uri: 'registry://models/{id}',
              description:
                'Details for a specific model — URL-encode the canonical ID (e.g. registry://models/anthropic%2Fclaude-sonnet-4-5)',
            },
          ].map((resource) => (
            <div key={resource.uri} className="card" style={{ background: 'var(--bg)' }}>
              <code style={{ fontSize: '1rem', color: 'var(--accent)' }}>{resource.uri}</code>
              <p style={{ margin: '0.4rem 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                {resource.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Available Prompts</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Reusable prompt templates that guide model-selection and comparison workflows (accessible
          via <code>prompts/get</code>).
        </p>
        <div className="stack">
          {[
            {
              name: 'select_model',
              description: 'Generate a structured prompt to select the best model for a task',
              params:
                '{ task_description: string, budget_usd_per_1k_tokens?: string, min_context_length?: string }',
            },
            {
              name: 'compare_models_prompt',
              description: 'Generate a structured prompt to compare a set of models side-by-side',
              params: '{ model_ids: string }',
            },
          ].map((prompt) => (
            <div key={prompt.name} className="card" style={{ background: 'var(--bg)' }}>
              <code style={{ fontSize: '1rem', color: 'var(--accent)' }}>{prompt.name}</code>
              <p style={{ margin: '0.4rem 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                {prompt.description}
              </p>
              <pre>
                <code>{prompt.params}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Claude Code</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Add the server with one command — Claude Code runs the OAuth browser login itself:
        </p>
        <pre>
          <code>{`claude mcp add --transport http registry ${baseUrl}/api/mcp`}</code>
        </pre>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          The first time an agent uses a registry tool, a browser opens to authorize; after that it
          stays connected.
        </p>
      </div>

      <div className="card">
        <h2>Cursor</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Add to <code>~/.cursor/mcp.json</code> (or the project&apos;s <code>.cursor/mcp.json</code>).
          Cursor completes the OAuth flow in the browser on first use:
        </p>
        <pre>
          <code>
            {JSON.stringify(
              {
                mcpServers: {
                  'openrouter-registry': {
                    url: `${baseUrl}/api/mcp`,
                  },
                },
              },
              null,
              2
            )}
          </code>
        </pre>
      </div>

      <div className="card">
        <h2>Claude Desktop Configuration</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Add this to your Claude Desktop MCP configuration. It will prompt you to authorize in the
          browser on first use:
        </p>
        <pre>
          <code>
            {JSON.stringify(
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
            )}
          </code>
        </pre>
      </div>

      <div className="card">
        <h2>GitHub Copilot (VS Code)</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Add to your workspace{`'`}s <code>.vscode/mcp.json</code> (or under{' '}
          <code>&quot;mcp&quot;</code> in <code>settings.json</code>):
        </p>
        <pre>
          <code>
            {JSON.stringify(
              {
                servers: {
                  'openrouter-registry': {
                    type: 'http',
                    url: `${baseUrl}/api/mcp`,
                  },
                },
              },
              null,
              2
            )}
          </code>
        </pre>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          VS Code completes the OAuth browser login automatically. Only if your client can&apos;t do
          OAuth discovery, fall back to a bearer token in a <code>headers</code> object as{' '}
          <code>{`"Authorization": "Bearer YOUR_ACCESS_TOKEN"`}</code>.
        </p>
      </div>

      <div className="card">
        <h2>OpenAI Codex CLI</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Add to <code>~/.codex/config.toml</code>:
        </p>
        <pre>
          <code>{`[mcp_servers.openrouter-registry]\nurl = "${baseUrl}/api/mcp"`}</code>
        </pre>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          Codex performs OAuth discovery automatically. Only if it can&apos;t, add{' '}
          <code>bearer_token = &quot;YOUR_ACCESS_TOKEN&quot;</code> as a fallback.
        </p>
      </div>

      <div className="card">
        <h2>Usage Examples</h2>
        <div className="stack">
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Resolve a model ID in your agent:
            </p>
            <pre>
              <code>{`// In your agent/assistant:
const result = await mcp.callTool('resolve_model', { input: 'anthropic/claude-sonnet-4-5' });
// → { resolved: 'anthropic/claude-sonnet-4-5', source: 'canonical', found: true, model: {...} }`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Search models by name or provider:
            </p>
            <pre>
              <code>{`const results = await mcp.callTool('search_models', { query: 'claude', limit: 10 });`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Find models by natural language description:
            </p>
            <pre>
              <code>{`const results = await mcp.callTool('semantic_search', {
  query: 'fast cheap summarization model with large context',
  limit: 10,
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Filter models by modality (e.g. vision models):
            </p>
            <pre>
              <code>{`const models = await mcp.callTool('find_models_by_criteria', {
  modality: 'text+image',
  limit: 20,
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Find models within a budget and context window:
            </p>
            <pre>
              <code>{`const models = await mcp.callTool('find_models_by_criteria', {
  maxInputPricePer1k: 0.005,
  maxOutputPricePer1k: 0.015,
  minContextLength: 32000,
  limit: 20,
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Compare models side-by-side:
            </p>
            <pre>
              <code>{`const comparison = await mcp.callTool('compare_models', {
  ids: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-pro-1.5'],
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Read the model list as a resource:
            </p>
            <pre>
              <code>{`const result = await mcp.readResource('registry://models');
// → { contents: [{ mimeType: 'application/json', text: '{"models":[...]}' }] }`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Use the select_model prompt to guide model selection:
            </p>
            <pre>
              <code>{`const prompt = await mcp.getPrompt('select_model', {
  task_description: 'Summarize long legal documents',
  budget_usd_per_1k_tokens: '0.005',
  min_context_length: '32000',
});
// → prompt messages that instruct the model how to pick the best option`}</code>
            </pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Use the compare_models_prompt for a structured comparison:
            </p>
            <pre>
              <code>{`const prompt = await mcp.getPrompt('compare_models_prompt', {
  model_ids: 'anthropic/claude-sonnet-4-5,openai/gpt-4o',
});`}</code>
            </pre>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Cron Sync</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          The registry is automatically refreshed daily (00:00 UTC) via Vercel Cron, and can also be
          triggered on demand from the admin panel:
        </p>
        <pre>
          <code>{`// apps/mcp/vercel.json
{
  "crons": [
    {
      "path": "/api/cron/sync",
      "schedule": "0 0 * * *"
    }
  ]
}`}</code>
        </pre>
      </div>
    </div>
  );
}
