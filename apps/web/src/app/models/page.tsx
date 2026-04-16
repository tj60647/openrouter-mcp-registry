'use client';

import { useEffect, useState, useCallback } from 'react';
import type { Model } from '@openrouter-mcp/shared';

interface ModelsResponse {
  models: Model[];
  count: number;
  limit: number;
  offset: number;
}

export default function ModelsPage() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [debouncedModelQuery, setDebouncedModelQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedModelQuery(modelQuery.trim());
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [modelQuery]);

  const fetchModels = useCallback(async (searchText = debouncedModelQuery) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const normalizedProvider = provider.trim();
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
  }, [provider, debouncedModelQuery, offset]);

  useEffect(() => { fetchModels(); }, [fetchModels]);

  return (
    <div className="stack">
      <div>
        <h1>Models</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          All models cached from OpenRouter. Filter by exact provider and search model IDs or display names.
        </p>
      </div>

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Provider (exact, e.g. google)"
          value={provider}
          onChange={(e) => { setProvider(e.target.value); setOffset(0); }}
          style={{ maxWidth: 220 }}
        />
        <input
          type="text"
          placeholder="Search model name or ID (e.g. gemini)"
          value={modelQuery}
          onChange={(e) => { setModelQuery(e.target.value); setOffset(0); }}
          style={{ maxWidth: 300 }}
        />
        <button onClick={() => fetchModels(modelQuery.trim())}>Refresh</button>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {loading && <div className="loading">Loading models...</div>}

      {data && !loading && (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Showing {data.offset + 1}–{data.offset + data.models.length} of {data.count} total
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
