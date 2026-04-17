'use client';

import { useState } from 'react';
import type { Model } from '@openrouter-mcp/shared';

interface ResolveResponse {
  input: string;
  resolved: string;
  source: 'canonical' | 'normalized';
  found: boolean;
  model: Model | null;
}

export default function ResolvePage() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: input.trim() }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: unknown };
        throw new Error(String(err.error));
      }
      const json = await res.json() as ResolveResponse;
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  const quickExamples = ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-pro-1.5', 'openrouter/auto'];

  return (
    <div className="stack">
      <div>
        <h1>Resolve Model</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Enter a canonical model ID to resolve it to the registered model.
        </p>
      </div>

      <div className="card">
        <form onSubmit={handleResolve} className="stack">
          <div>
            <label htmlFor="model-input" style={{ display: 'block', marginBottom: '0.4rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              Model ID
            </label>
            <input
              id="model-input"
              type="text"
              placeholder="e.g. anthropic/claude-sonnet-4-5, openai/gpt-4o"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
            {quickExamples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setInput(example)}
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}
              >
                {example}
              </button>
            ))}
          </div>
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? 'Resolving...' : 'Resolve →'}
          </button>
        </form>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {result && (
        <div className="card">
          <h3>Resolution Result</h3>
          <div className="stack" style={{ marginTop: '1rem' }}>
            <div className="grid-2">
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.2rem' }}>Input</p>
                <code>{result.input}</code>
              </div>
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.2rem' }}>Resolved To</p>
                <code style={{ color: 'var(--accent)' }}>{result.resolved}</code>
              </div>
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.2rem' }}>Source</p>
                <span className={`badge badge-${result.source === 'canonical' ? 'success' : 'warning'}`}>
                  {result.source}
                </span>
              </div>
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.2rem' }}>Found in Registry</p>
                <span className={`badge badge-${result.found ? 'success' : 'warning'}`}>
                  {result.found ? 'Yes' : 'No'}
                </span>
              </div>
            </div>

            {result.model && (
              <div>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>Model Details</p>
                <div className="grid-2">
                  <div><span style={{ color: 'var(--text-muted)' }}>Provider:</span> {result.model.provider}</div>
                  <div><span style={{ color: 'var(--text-muted)' }}>Display Name:</span> {result.model.displayName}</div>
                  <div><span style={{ color: 'var(--text-muted)' }}>Context:</span> {result.model.contextLength ? `${result.model.contextLength.toLocaleString()} tokens` : '—'}</div>
                  <div><span style={{ color: 'var(--text-muted)' }}>Input Price/1k:</span> {result.model.inputPricePer1k != null ? `$${result.model.inputPricePer1k}` : '—'}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
