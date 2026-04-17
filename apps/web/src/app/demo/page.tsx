'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import MarkdownRenderer from '../../components/MarkdownRenderer';

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
}

type AssistantBlock =
  | { kind: 'reasoning'; content: string }
  | { kind: 'tool_call'; id: string; name: string; done: boolean; error?: boolean }
  | { kind: 'text'; content: string };

interface UserMessage {
  id: string;
  role: 'user';
  text: string;
}

interface AssistantMessage {
  id: string;
  role: 'assistant';
  blocks: AssistantBlock[];
}

type Message = UserMessage | AssistantMessage;

interface AgentConfig {
  model: string;
  systemPrompt: string;
  parameters: Record<string, unknown>;
}

// ── Stream event types ────────────────────────────────────────────────────────

type StreamEvent =
  | { type: 'model'; model: string }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'tool_call'; name: string; id: string }
  | { type: 'tool_result'; id: string; name: string; content: string; error?: boolean }
  | { type: 'text_delta'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

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

// ── AgentModal ────────────────────────────────────────────────────────────────

function AgentModal({
  config,
  onClose,
}: {
  config: AgentConfig | null;
  onClose: () => void;
}) {
  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: '1rem',
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 560,
          maxHeight: '80vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ marginBottom: 0 }}>Agent Configuration</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              padding: '0.25rem 0.6rem',
              fontSize: '1rem',
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {config === null ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
        ) : (
          <>
            {/* Model */}
            <div>
              <div
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-muted)',
                  marginBottom: '0.4rem',
                }}
              >
                Model
              </div>
              <code
                style={{
                  background: 'rgba(99,102,241,0.12)',
                  padding: '0.35rem 0.75rem',
                  borderRadius: 6,
                  fontSize: '0.9rem',
                  display: 'inline-block',
                  color: 'var(--accent)',
                }}
              >
                {config.model}
              </code>
            </div>

            {/* System instructions */}
            <div>
              <div
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-muted)',
                  marginBottom: '0.4rem',
                }}
              >
                System Instructions
              </div>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '0.85rem',
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {config.systemPrompt}
              </pre>
            </div>

            {/* Parameters */}
            <div>
              <div
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-muted)',
                  marginBottom: '0.4rem',
                }}
              >
                Model Parameters
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                  fontSize: '0.875rem',
                }}
              >
                {Object.entries(config.parameters).map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '0.3rem 0',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span style={{ color: 'var(--text-muted)' }}>{k}</span>
                    <code style={{ fontSize: '0.85rem' }}>{String(v)}</code>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── ReasoningBlock ────────────────────────────────────────────────────────────

function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        margin: '0.4rem 0',
        border: '1px solid rgba(99,102,241,0.25)',
        borderRadius: 6,
        overflow: 'hidden',
        fontSize: '0.85rem',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'rgba(99,102,241,0.07)',
          border: 'none',
          color: 'var(--text-muted)',
          padding: '0.35rem 0.75rem',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.8rem',
          fontWeight: 500,
        }}
      >
        <span style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none' }}>
          ▶
        </span>
        Reasoning
      </button>
      {open && (
        <div
          style={{
            padding: '0.6rem 0.75rem',
            whiteSpace: 'pre-wrap',
            color: 'var(--text-muted)',
            lineHeight: 1.6,
            background: 'rgba(99,102,241,0.03)',
            borderTop: '1px solid rgba(99,102,241,0.15)',
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

// ── ToolCallBlock ─────────────────────────────────────────────────────────────

function ToolCallBlock({ block }: { block: Extract<AssistantBlock, { kind: 'tool_call' }> }) {
  return (
    <div
      style={{
        fontSize: '0.8rem',
        color: 'var(--text-muted)',
        background: 'rgba(99,102,241,0.07)',
        border: `1px solid ${block.error ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.2)'}`,
        borderRadius: 6,
        padding: '0.4rem 0.75rem',
        margin: '0.25rem 0',
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
      }}
    >
      <span
        style={{
          color: block.error ? 'var(--error)' : block.done ? 'var(--success)' : 'var(--accent)',
          fontSize: '0.9rem',
        }}
      >
        {block.error ? '✗' : block.done ? '✓' : '⟳'}
      </span>
      <span>
        Tool: <code style={{ fontSize: '0.8rem' }}>{block.name}</code>
      </span>
      {!block.done && (
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', opacity: 0.6 }}>running…</span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DemoPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch agent config on mount
  useEffect(() => {
    fetch('/api/chat')
      .then((r) => r.json() as Promise<AgentConfig>)
      .then((cfg) => {
        setAgentConfig(cfg);
        setModel(cfg.model);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  /** Update a specific assistant message's blocks in-place. */
  const updateAssistantBlocks = useCallback(
    (msgId: string, updater: (blocks: AssistantBlock[]) => AssistantBlock[]) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.role === 'assistant'
            ? { ...m, blocks: updater(m.blocks) }
            : m
        )
      );
    },
    []
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loading) return;

      const userMsg: UserMessage = { id: uid(), role: 'user', text: trimmed };
      setMessages((prev) => [...prev, userMsg]);
      setError(null);
      setLoading(true);

      const newHistory: ApiMessage[] = [...history, { role: 'user', content: trimmed }];

      // Create an empty assistant message we'll fill in via streaming
      const assistantId = uid();
      const emptyAssistant: AssistantMessage = { id: assistantId, role: 'assistant', blocks: [] };
      setMessages((prev) => [...prev, emptyAssistant]);

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: newHistory }),
        });

        if (!res.ok || !res.body) {
          const errData = (await res.json()) as { error?: string };
          throw new Error(errData.error ?? `HTTP ${res.status}`);
        }

        // ── Parse SSE stream ──────────────────────────────────────────────────
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let finalText = '';

        outer: while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();

            let evt: StreamEvent;
            try {
              evt = JSON.parse(raw) as StreamEvent;
            } catch {
              continue;
            }

            if (evt.type === 'model') {
              setModel(evt.model);
            } else if (evt.type === 'reasoning_delta') {
              updateAssistantBlocks(assistantId, (blocks) => {
                const last = blocks[blocks.length - 1];
                if (last?.kind === 'reasoning') {
                  return [
                    ...blocks.slice(0, -1),
                    { ...last, content: last.content + evt.delta },
                  ];
                }
                return [...blocks, { kind: 'reasoning', content: evt.delta }];
              });
            } else if (evt.type === 'tool_call') {
              updateAssistantBlocks(assistantId, (blocks) => [
                ...blocks,
                { kind: 'tool_call', id: evt.id, name: evt.name, done: false },
              ]);
            } else if (evt.type === 'tool_result') {
              updateAssistantBlocks(assistantId, (blocks) =>
                blocks.map((b) =>
                  b.kind === 'tool_call' && b.id === evt.id
                    ? { ...b, done: true, error: evt.error }
                    : b
                )
              );
            } else if (evt.type === 'text_delta') {
              finalText += evt.delta;
              updateAssistantBlocks(assistantId, (blocks) => {
                const last = blocks[blocks.length - 1];
                if (last?.kind === 'text') {
                  return [
                    ...blocks.slice(0, -1),
                    { ...last, content: last.content + evt.delta },
                  ];
                }
                return [...blocks, { kind: 'text', content: evt.delta }];
              });
            } else if (evt.type === 'error') {
              setError(evt.message);
              break outer;
            } else if (evt.type === 'done') {
              break outer;
            }
          }
        }

        setHistory([...newHistory, { role: 'assistant', content: finalText }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
        // Remove the empty assistant message on error
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } finally {
        setLoading(false);
      }
    },
    [history, loading, updateAssistantBlocks]
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    void sendMessage(text);
  }

  function openAgentModal() {
    if (!agentConfig) {
      // Fetch if not yet loaded
      fetch('/api/chat')
        .then((r) => r.json() as Promise<AgentConfig>)
        .then((cfg) => setAgentConfig(cfg))
        .catch(() => {});
    }
    setShowAgentModal(true);
  }

  return (
    <div className="stack" style={{ height: 'calc(100vh - 8rem)', maxHeight: 900 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h1>Live Demo</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Chat with an AI assistant that uses the MCP registry tools — search models,
            compare pricing, and explore the OpenRouter catalogue in real time.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexShrink: 0, paddingTop: '0.35rem' }}>
          {model && (
            <span
              className="badge badge-info"
              style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}
              title="Active model"
            >
              {model}
            </span>
          )}
          <button
            type="button"
            onClick={openAgentModal}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              fontSize: '0.8rem',
              padding: '0.3rem 0.7rem',
              whiteSpace: 'nowrap',
            }}
          >
            Agent Info
          </button>
        </div>
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
            {/* Role label */}
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

            {m.role === 'user' ? (
              <div
                style={{
                  background: 'rgba(99,102,241,0.1)',
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
            ) : (
              <div
                style={{
                  background: 'var(--bg-hover)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '0.75rem 1rem',
                  lineHeight: 1.6,
                  fontSize: '0.95rem',
                }}
              >
                {m.blocks.length === 0 && loading ? (
                  <span style={{ color: 'var(--text-muted)' }}>Thinking…</span>
                ) : (
                  m.blocks.map((block, bi) => {
                    if (block.kind === 'reasoning') {
                      return <ReasoningBlock key={bi} content={block.content} />;
                    }
                    if (block.kind === 'tool_call') {
                      return <ToolCallBlock key={bi} block={block} />;
                    }
                    // text block
                    return <MarkdownRenderer key={bi} content={block.content} />;
                  })
                )}
              </div>
            )}
          </div>
        ))}

        {error && <div className="error-msg">{error}</div>}

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

      {/* Agent Info modal */}
      {showAgentModal && (
        <AgentModal config={agentConfig} onClose={() => setShowAgentModal(false)} />
      )}
    </div>
  );
}
