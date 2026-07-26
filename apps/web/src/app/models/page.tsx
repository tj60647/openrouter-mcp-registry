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

type SortBy = 'id' | 'newest' | 'context' | 'input_price' | 'output_price';
type Tab = 'active' | 'unavailable';

function formatDate(date: Date | string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// The rows scrolling beneath are white, so the pinned header needs its own fill
// (studio thead bg-gray-50) plus a hard black rule to occlude them cleanly.
const stickyTh: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  background: 'var(--bg-subtle)',
  borderBottom: '1px solid var(--border-strong)',
  boxShadow: '0 1px 0 var(--border-strong)',
  zIndex: 1,
};

// Default sort direction per column (first click activates this direction)
const DEFAULT_SORT_DIR: Record<SortBy, 'asc' | 'desc'> = {
  id: 'asc',
  newest: 'desc',
  context: 'desc',
  input_price: 'asc',
  output_price: 'asc',
};

function SortableHeader({
  column,
  activeSortBy,
  sortDir,
  onClick,
  children,
  style,
  title,
}: {
  column: SortBy;
  activeSortBy: SortBy;
  sortDir: 'asc' | 'desc';
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
  title?: string;
}) {
  const active = column === activeSortBy;
  const icon = !active ? '⇅' : sortDir === 'asc' ? '↑' : '↓';
  return (
    <th
      onClick={onClick}
      title={title}
      style={{
        ...stickyTh,
        cursor: 'pointer',
        color: active ? 'var(--accent)' : undefined,
        userSelect: 'none',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
      <span style={{ marginLeft: '0.3rem', color: active ? 'var(--accent)' : 'var(--text-faint)' }}>
        {icon}
      </span>
    </th>
  );
}

function FilterHeader({
  active,
  onClick,
  children,
  title,
  style,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <th
      onClick={onClick}
      title={title}
      style={{
        ...stickyTh,
        cursor: 'pointer',
        color: active ? 'var(--accent)' : undefined,
        textAlign: 'center',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
      {active && (
        <span
          style={{
            marginLeft: '0.35rem',
            background: 'var(--accent)',
            color: 'var(--bg)',
            fontSize: '0.6rem',
            borderRadius: 0,
            padding: '0.05rem 0.4rem',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            verticalAlign: 'middle',
          }}
        >
          ON
        </span>
      )}
    </th>
  );
}

export default function ModelsPage() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('active');
  const [provider, setProvider] = useState('');
  const [providers, setProviders] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [debouncedModelQuery, setDebouncedModelQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
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
      params.set('sortDir', sortDir);
      if (toolsOnly) params.set('toolsOnly', 'true');
      if (reasoningOnly) params.set('reasoningOnly', 'true');
      if (tab === 'active') params.set('availableOnly', 'true');
      if (tab === 'unavailable') params.set('retiredOnly', 'true');
      const res = await fetch(`/api/models?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ModelsResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [debouncedModelQuery, normalizedProvider, offset, sortBy, sortDir, toolsOnly, reasoningOnly, tab]);

  // Tri-state sort: off → defaultDir → flippedDir → off (back to id/asc)
  function handleSortClick(column: SortBy) {
    if (sortBy !== column) {
      // Activate this column with its natural default direction
      setSortBy(column);
      setSortDir(DEFAULT_SORT_DIR[column]);
    } else {
      const defaultDir = DEFAULT_SORT_DIR[column];
      if (sortDir === defaultDir) {
        // Second click: flip direction
        setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
      } else {
        // Third click: deactivate — back to default id sort
        setSortBy('id');
        setSortDir('asc');
      }
    }
    setOffset(0);
  }

  function clearFilters() {
    setProvider('');
    setModelQuery('');
    setDebouncedModelQuery('');
    setSortBy('id');
    setSortDir('asc');
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
          Active means present in the latest registry sync. Unavailable means missing from the latest sync; scheduled provider expiry is tracked separately when OpenRouter supplies it.
        </p>
      </div>

      {/* Active / Unavailable tabs */}
      <div className="row" style={{ gap: '0.25rem' }}>
        {(['active', 'unavailable'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setOffset(0); }}
            className={tab === t ? undefined : 'btn-ghost'}
            style={{
              /* Studio toggle pair (AdminLayout.tsx:128-132): active =
                 border-black bg-black text-white; inactive = the ghost button. */
              ...(tab === t
                ? { background: 'var(--accent)', color: 'var(--bg)', border: '1px solid var(--accent)' }
                : {}),
              borderRadius: 0,
              padding: '0.4rem 1rem',
              cursor: 'pointer',
              fontSize: '0.625rem',
              fontWeight: 700,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Filter bar: provider + search + actions */}
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
            {/* Scrollable table container — headers remain visible while rows scroll */}
            <div style={{ overflowX: 'auto' }}>
              {/* 316px tracks the tighter chrome: 44px nav + 2rem main padding. */}
              <div style={{ maxHeight: 'calc(100vh - 316px)', minHeight: 200, overflowY: 'auto' }}>
                <table style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                  <thead>
                    <tr>
                      <SortableHeader
                        column="id"
                        activeSortBy={sortBy}
                        sortDir={sortDir}
                        onClick={() => handleSortClick('id')}
                        title="Sort alphabetically by model ID"
                      >
                        Model ID
                      </SortableHeader>
                      <th style={stickyTh}>Provider</th>
                      <th style={stickyTh}>Display Name</th>
                      <SortableHeader
                        column="context"
                        activeSortBy={sortBy}
                        sortDir={sortDir}
                        onClick={() => handleSortClick('context')}
                        title="Sort by context window size"
                        style={{ textAlign: 'right' }}
                      >
                        Context
                      </SortableHeader>
                      <SortableHeader
                        column="input_price"
                        activeSortBy={sortBy}
                        sortDir={sortDir}
                        onClick={() => handleSortClick('input_price')}
                        title="Sort by input price"
                        style={{ textAlign: 'right' }}
                      >
                        Input $/1k
                      </SortableHeader>
                      <SortableHeader
                        column="output_price"
                        activeSortBy={sortBy}
                        sortDir={sortDir}
                        onClick={() => handleSortClick('output_price')}
                        title="Sort by output price"
                        style={{ textAlign: 'right' }}
                      >
                        Output $/1k
                      </SortableHeader>
                      <SortableHeader
                        column="newest"
                        activeSortBy={sortBy}
                        sortDir={sortDir}
                        onClick={() => handleSortClick('newest')}
                        title={tab === 'active' ? 'Sort by publish date' : 'Sort by first unavailable sync date'}
                      >
                        {tab === 'active' ? 'Published' : 'Unavailable Since'}
                      </SortableHeader>
                      <FilterHeader
                        active={toolsOnly}
                        onClick={() => { setToolsOnly(!toolsOnly); setOffset(0); }}
                        title={toolsOnly ? 'Showing tool-capable models only — click to show all' : 'Click to filter to tool-capable models only'}
                      >
                        Tools
                      </FilterHeader>
                      <FilterHeader
                        active={reasoningOnly}
                        onClick={() => { setReasoningOnly(!reasoningOnly); setOffset(0); }}
                        title={reasoningOnly ? 'Showing reasoning models only — click to show all' : 'Click to filter to reasoning models only'}
                      >
                        Reasoning
                      </FilterHeader>
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.map((m) => (
                      <tr key={m.id}>
                        <td><code style={{ fontSize: '0.8rem' }}>{m.id}</code></td>
                        <td><span className="badge badge-info">{m.provider}</span></td>
                        <td>{m.displayName}</td>
                        <td style={{ textAlign: 'right' }}>
                          {m.contextLength ? `${Math.floor(m.contextLength / 1000)}k` : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {m.inputPricePer1k != null ? `$${m.inputPricePer1k.toFixed(4)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {m.outputPricePer1k != null ? `$${m.outputPricePer1k.toFixed(4)}` : '—'}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                          {formatDate(tab === 'active' ? m.createdAt : m.retiredAt)}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {m.supportedParameters.includes('tools')
                            ? <span style={{ color: 'var(--text)', fontWeight: 700 }}>✓</span>
                            : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {m.supportedParameters.includes('reasoning')
                            ? <span style={{ color: 'var(--text)', fontWeight: 700 }}>✓</span>
                            : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
