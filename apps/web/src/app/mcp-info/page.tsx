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
              params: '{ limit?: number, offset?: number, provider?: string, query?: string }',
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
              params: '{ query: string, limit?: number, offset?: number }',
            },
            {
              name: 'find_models_by_criteria',
              description: 'Filter models by budget and context constraints',
              params: '{ maxInputPricePer1k?: number, maxOutputPricePer1k?: number, minContextLength?: number, limit?: number, offset?: number }',
            },
            {
              name: 'compare_models',
              description: 'Compare 2–5 models side-by-side on pricing, context length, and metadata',
              params: '{ ids: string[] }',
            },
            {
              name: 'get_registry_status',
              description: 'Get the current sync status of the model registry',
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
        <h2>Available Resources</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Read registry data directly via MCP resource URIs (read-only, accessible via <code>resources/read</code>).
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
              description: 'Details for a specific model — URL-encode the canonical ID (e.g. registry://models/anthropic%2Fclaude-sonnet-4-5)',
            },
          ].map((resource) => (
            <div key={resource.uri} className="card" style={{ background: 'var(--bg)' }}>
              <code style={{ fontSize: '1rem', color: 'var(--accent)' }}>{resource.uri}</code>
              <p style={{ margin: '0.4rem 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{resource.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Available Prompts</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          Reusable prompt templates that guide model-selection and comparison workflows (accessible via <code>prompts/get</code>).
        </p>
        <div className="stack">
          {[
            {
              name: 'select_model',
              description: 'Generate a structured prompt to select the best model for a task',
              params: '{ task_description: string, budget_usd_per_1k_tokens?: string, min_context_length?: string }',
            },
            {
              name: 'compare_models_prompt',
              description: 'Generate a structured prompt to compare a set of models side-by-side',
              params: '{ model_ids: string }',
            },
          ].map((prompt) => (
            <div key={prompt.name} className="card" style={{ background: 'var(--bg)' }}>
              <code style={{ fontSize: '1rem', color: 'var(--accent)' }}>{prompt.name}</code>
              <p style={{ margin: '0.4rem 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>{prompt.description}</p>
              <pre><code>{prompt.params}</code></pre>
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
              Resolve a model ID in your agent:
            </p>
            <pre><code>{`// In your agent/assistant:
const result = await mcp.callTool('resolve_model', { input: 'anthropic/claude-sonnet-4-5' });
// → { resolved: 'anthropic/claude-sonnet-4-5', source: 'canonical', found: true, model: {...} }`}</code></pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Search models by name or provider:
            </p>
            <pre><code>{`const results = await mcp.callTool('search_models', { query: 'claude', limit: 10 });`}</code></pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Find models within a budget and context window:
            </p>
            <pre><code>{`const models = await mcp.callTool('find_models_by_criteria', {
  maxInputPricePer1k: 0.005,
  maxOutputPricePer1k: 0.015,
  minContextLength: 32000,
  limit: 20,
});`}</code></pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Compare models side-by-side:
            </p>
            <pre><code>{`const comparison = await mcp.callTool('compare_models', {
  ids: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-pro-1.5'],
});`}</code></pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Read the model list as a resource:
            </p>
            <pre><code>{`const result = await mcp.readResource('registry://models');
// → { contents: [{ mimeType: 'application/json', text: '{"models":[...]}' }] }`}</code></pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Use the select_model prompt to guide model selection:
            </p>
            <pre><code>{`const prompt = await mcp.getPrompt('select_model', {
  task_description: 'Summarize long legal documents',
  budget_usd_per_1k_tokens: '0.005',
  min_context_length: '32000',
});
// → prompt messages that instruct the model how to pick the best option`}</code></pre>
          </div>
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>
              Use the compare_models_prompt for a structured comparison:
            </p>
            <pre><code>{`const prompt = await mcp.getPrompt('compare_models_prompt', {
  model_ids: 'anthropic/claude-sonnet-4-5,openai/gpt-4o',
});`}</code></pre>
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
