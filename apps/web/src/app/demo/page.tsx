'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolEvent {
  name: string;
  done: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls?: ToolEvent[];
}

interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── Example prompts ───────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  'What are the cheapest models available?',
  'Compare anthropic/claude-sonnet-4-5 and openai/gpt-4o',
  'Find models with at least 128k context window',
  'What Anthropic models are in the registry?',
  'When was the registry last synced?',
];

function uid() {
  return Math.random().toString(36).slice(2);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DemoPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeTools]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMsg: Message = { id: uid(), role: 'user', text: trimmed };
      setMessages((prev) => [...prev, userMsg]);
      setError(null);
      setLoading(true);
      setActiveTools([]);

      const newHistory: ApiMessage[] = [...history, { role: 'user', content: trimmed }];

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: newHistory }),
        });

        if (!res.ok) {
          const errData = await res.json() as { error?: string };
          throw new Error(errData.error ?? `HTTP ${res.status}`);
        }

        // Read the plain-text response
        const assistantText = await res.text();

        const assistantMsg: Message = {
          id: uid(),
          role: 'assistant',
          text: assistantText,
        };

        setMessages((prev) => [...prev, assistantMsg]);
        setHistory([...newHistory, { role: 'assistant', content: assistantText }]);
        setActiveTools([]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        setLoading(false);
      }
    },
    [history, loading]
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    void sendMessage(text);
  }

  return (
    <div className="stack" style={{ height: 'calc(100vh - 8rem)', maxHeight: 900 }}>
      <div>
        <h1>Live Demo</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Chat with an AI assistant that uses the MCP registry tools — search models,
          compare pricing, and explore the OpenRouter catalogue in real time.
        </p>
      </div>

      {/* Chat window */}
      <div
        className="card"
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          padding: '1.25rem',
          minHeight: 0,
        }}
      >
        {messages.length === 0 && !loading && (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)' }}>
            <p style={{ marginBottom: '1.25rem', fontSize: '0.95rem' }}>Try one of these prompts:</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
              {EXAMPLE_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => { setInput(p); }}
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-muted)',
                    borderRadius: 6,
                    padding: '0.4rem 1rem',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                    maxWidth: 420,
                    width: '100%',
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id}>
            <div
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: m.role === 'user' ? 'var(--accent)' : 'var(--text-muted)',
                marginBottom: '0.3rem',
              }}
            >
              {m.role === 'user' ? 'You' : 'Assistant'}
            </div>
            <div
              style={{
                background: m.role === 'user' ? 'rgba(99,102,241,0.1)' : 'var(--bg-hover)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.75rem 1rem',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
                fontSize: '0.95rem',
              }}
            >
              {m.text}
            </div>
          </div>
        ))}

        {/* Loading / tool call indicator */}
        {loading && (
          <div>
            <div
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
                marginBottom: '0.3rem',
              }}
            >
              Assistant
            </div>
            {activeTools.map((t, i) => (
              <div
                key={i}
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-muted)',
                  background: 'rgba(99,102,241,0.07)',
                  border: '1px solid rgba(99,102,241,0.2)',
                  borderRadius: 6,
                  padding: '0.4rem 0.75rem',
                  marginBottom: '0.4rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <span style={{ color: t.done ? 'var(--success)' : 'var(--accent)' }}>
                  {t.done ? '✓' : '⟳'}
                </span>
                <span>
                  Tool call: <code style={{ fontSize: '0.8rem' }}>{t.name}</code>
                </span>
              </div>
            ))}
            {activeTools.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Thinking…</div>
            )}
          </div>
        )}

        {error && (
          <div className="error-msg">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input form */}
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about models, pricing, context windows…"
          rows={2}
          disabled={loading}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (input.trim()) {
                e.currentTarget.form?.requestSubmit();
              }
            }
          }}
          style={{ resize: 'none', flex: 1 }}
        />
        <button type="submit" disabled={loading || !input.trim()} style={{ flexShrink: 0 }}>
          {loading ? 'Sending…' : 'Send'}
        </button>
      </form>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '-0.5rem' }}>
        Press <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line
      </p>
    </div>
  );
}
