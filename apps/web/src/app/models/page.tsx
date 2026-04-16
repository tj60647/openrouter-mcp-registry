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

export default function ModelsPage() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState('');
  const [providers, setProviders] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [debouncedModelQuery, setDebouncedModelQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const normalizedProvider = provider.trim();
  const normalizedModelQuery = modelQuery.trim();
  const hasActiveFilters = normalizedProvider.length > 0 || normalizedModelQuery.length > 0;

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
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (normalizedProvider) params.set('provider', normalizedProvider);
      if (searchText) params.set('query', searchText);
      const res = await fetch(`/api/models?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ModelsResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [debouncedModelQuery, normalizedProvider, offset]);

  function clearFilters() {
    setProvider('');
    setModelQuery('');
    setDebouncedModelQuery('');
    setOffset(0);
  }

  useEffect(() => { fetchModels(); }, [fetchModels]);

  return (
    <div className="stack">
      <div>
        <h1>Models</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          All models cached from OpenRouter. Filter by provider and search model IDs or display names.
        </p>
      </div>

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
            <table>
              <thead>
                <tr>
                  <th>Model ID</th>
                  <th>Provider</th>
                  <th>Display Name</th>
                  <th>Context</th>
                  <th>Input $/1k</th>
                  <th>Output $/1k</th>
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
                  </tr>
                ))}
              </tbody>
            </table>
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
