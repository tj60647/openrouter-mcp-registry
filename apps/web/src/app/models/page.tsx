'use client';

import { useEffect, useState, useCallback } from 'react';
import type { Model } from '@openrouter-mcp/shared';

interface ModelsResponse {
  models: Model[];
  count: number;
  limit: number;
  offset: number;
}

interface ProvidersResponse {
  providers: string[];
}

function formatDate(date: Date | null): string {
  if (!date) return '—';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function ModelsPage() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState('');
  const [providers, setProviders] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [debouncedModelQuery, setDebouncedModelQuery] = useState('');
  const [sortBy, setSortBy] = useState('id');
  const [toolsOnly, setToolsOnly] = useState(false);
  const [reasoningOnly, setReasoningOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const normalizedProvider = provider.trim();
  const normalizedModelQuery = modelQuery.trim();
  const hasActiveFilters =
    normalizedProvider.length > 0 ||
    normalizedModelQuery.length > 0 ||
    sortBy !== 'id' ||
    toolsOnly ||
    reasoningOnly;

  useEffect(() => {
    async function fetchProviders() {
      try {
        const res = await fetch('/api/providers');
        if (res.ok) {
          const json = await res.json() as ProvidersResponse;
          setProviders(json.providers);
        }
      } catch (e) {
        console.error('Failed to fetch providers list:', e);
      }
    }
    void fetchProviders();
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedModelQuery(normalizedModelQuery);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [normalizedModelQuery]);

  const fetchModels = useCallback(async (searchText = debouncedModelQuery) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sortBy });
      if (normalizedProvider) params.set('provider', normalizedProvider);
      if (searchText) params.set('query', searchText);
      if (toolsOnly) params.set('toolsOnly', 'true');
      if (reasoningOnly) params.set('reasoningOnly', 'true');
      const res = await fetch(`/api/models?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ModelsResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [debouncedModelQuery, normalizedProvider, offset, sortBy, toolsOnly, reasoningOnly]);

  function clearFilters() {
    setProvider('');
    setModelQuery('');
    setDebouncedModelQuery('');
    setSortBy('id');
    setToolsOnly(false);
    setReasoningOnly(false);
    setOffset(0);
  }

  useEffect(() => { fetchModels(); }, [fetchModels]);

  return (
    <div className="stack">
      <div>
        <h1>Models</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          All models cached from OpenRouter. Filter by provider, capabilities, and sort order.
        </p>
      </div>

      {/* Filter row 1: provider + search */}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select
          value={provider}
          onChange={(e) => { setProvider(e.target.value); setOffset(0); }}
          style={{ maxWidth: 220 }}
        >
          <option value="">All Providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search model name or ID (e.g. gemini)"
          value={modelQuery}
          onChange={(e) => { setModelQuery(e.target.value); setOffset(0); }}
          style={{ maxWidth: 300 }}
        />
      </div>

      {/* Filter row 2: sort + capability toggles */}
      <div className="row" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <select
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value); setOffset(0); }}
          style={{ maxWidth: 200 }}
        >
          <option value="id">Sort: Alphabetical</option>
          <option value="newest">Sort: Newest First</option>
          <option value="context">Sort: Largest Context</option>
          <option value="input_price">Sort: Cheapest Input</option>
          <option value="output_price">Sort: Cheapest Output</option>
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-muted)', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={toolsOnly}
            onChange={(e) => { setToolsOnly(e.target.checked); setOffset(0); }}
            style={{ width: 'auto', cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
          Tool Use Only
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-muted)', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={reasoningOnly}
            onChange={(e) => { setReasoningOnly(e.target.checked); setOffset(0); }}
            style={{ width: 'auto', cursor: 'pointer', accentColor: 'var(--accent)' }}
          />
          Reasoning Only
        </label>

        <button onClick={() => fetchModels(normalizedModelQuery)}>Refresh</button>
        <button disabled={!hasActiveFilters} onClick={clearFilters}>Clear Filters</button>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading models...</div>}

      {data && !loading && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            {data.count > 0
              ? `Showing ${data.offset + 1}–${data.offset + data.models.length} of ${data.count} total`
              : 'Showing 0 of 0 total'}
            {normalizedProvider ? ` for provider "${normalizedProvider}"` : ''}
            {normalizedModelQuery ? `${normalizedProvider ? ' and' : ' for'} matching "${normalizedModelQuery}"` : ''}
          </p>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Model ID</th>
                    <th>Provider</th>
                    <th>Display Name</th>
                    <th>Context</th>
                    <th>Input $/1k</th>
                    <th>Output $/1k</th>
                    <th>Published</th>
                    <th>Reasoning</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((m) => (
                    <tr key={m.id}>
                      <td><code style={{ fontSize: '0.8rem' }}>{m.id}</code></td>
                      <td><span className="badge badge-info">{m.provider}</span></td>
                      <td>{m.displayName}</td>
                      <td>{m.contextLength ? `${Math.floor(m.contextLength / 1000)}k` : '—'}</td>
                      <td>{m.inputPricePer1k != null ? `$${m.inputPricePer1k.toFixed(4)}` : '—'}</td>
                      <td>{m.outputPricePer1k != null ? `$${m.outputPricePer1k.toFixed(4)}` : '—'}</td>
                      <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        {formatDate(m.createdAt)}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {m.supportedParameters.includes('reasoning')
                          ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>✓</span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="row">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              ← Previous
            </button>
            <button disabled={data.models.length < limit} onClick={() => setOffset(offset + limit)}>
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
