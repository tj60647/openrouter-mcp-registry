'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import type { DynamicToolUIPart, TextUIPart } from 'ai';
import MarkdownRenderer from '../../components/MarkdownRenderer';

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentConfig {
  model: string;
  systemPrompt: string;
  parameters: Record<string, unknown>;
  availableModels: string[];
}

// ── Example prompts ───────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  'What are the cheapest models available?',
  'Compare anthropic/claude-sonnet-4-5 and openai/gpt-4o',
  'Find models with at least 128k context window',
  'What Anthropic models are in the registry?',
  'When was the registry last synced?',
];

// ── PulsingIndicator ─────────────────────────────────────────────────────────

function PulsingIndicator() {
  return (
    <svg
      width="36"
      height="12"
      viewBox="0 0 36 12"
      aria-label="Loading agent configuration"
      style={{ display: 'block' }}
    >
      {[6, 18, 30].map((cx, i) => (
        <circle key={cx} cx={cx} cy={6} r={4} fill="var(--accent)">
          <animate
            attributeName="opacity"
            values="0.2;1;0.2"
            dur="1.2s"
            begin={`${i * 0.3}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values="2.5;4;2.5"
            dur="1.2s"
            begin={`${i * 0.3}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  );
}

// ── AgentModal ────────────────────────────────────────────────────────────────

function AgentModal({
  config,
  selectedModel,
  onModelChange,
  onClose,
}: {
  config: AgentConfig | null;
  selectedModel: string | null;
  onModelChange: (model: string) => void;
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
          <h2 style={{ marginBottom: 0 }}>Model Settings</h2>
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
          <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem 0' }}>
            <PulsingIndicator />
          </div>
        ) : (
          <>
            {/* Model selector */}
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
              <select
                value={selectedModel ?? config.model}
                onChange={(e) => onModelChange(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  borderRadius: 6,
                  padding: '0.45rem 0.75rem',
                  fontSize: '0.9rem',
                  fontFamily: 'var(--mono)',
                }}
              >
                {/* Ensure current selection is always shown even if not in the list */}
                {[
                  ...new Set([
                    ...(selectedModel && !config.availableModels.includes(selectedModel as never)
                      ? [selectedModel]
                      : []),
                    ...config.availableModels,
                  ]),
                ].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
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

function ToolCallBlock({ part }: { part: DynamicToolUIPart }) {
  const isError = part.state === 'output-error';
  const isDone = part.state === 'output-available' || part.state === 'output-error';
  return (
    <div
      style={{
        fontSize: '0.8rem',
        color: 'var(--text-muted)',
        background: 'rgba(99,102,241,0.07)',
        border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.2)'}`,
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
          color: isError ? 'var(--error)' : isDone ? 'var(--success)' : 'var(--accent)',
          fontSize: '0.9rem',
        }}
      >
        {isError ? '✗' : isDone ? '✓' : '⟳'}
      </span>
      <span>
        Tool: <code style={{ fontSize: '0.8rem' }}>{part.toolName}</code>
      </span>
      {!isDone && (
        <span style={{ marginLeft: 'auto', fontSize: '0.75rem', opacity: 0.6 }}>running…</span>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DemoPage() {
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const { messages, sendMessage, status, error, stop } = useChat({
    body: selectedModel ? { model: selectedModel } : {},
  });

  const [input, setInput] = useState('');
  const [showAgentModal, setShowAgentModal] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const loading = status === 'submitted' || status === 'streaming';

  // Fetch agent config on mount
  useEffect(() => {
    fetch('/api/chat')
      .then(async (r) => (await r.json()) as AgentConfig)
      .then((cfg) => {
        setAgentConfig(cfg);
        setSelectedModel((prev) => prev ?? cfg.model);
      })
      .catch(() => {});
  }, []);

  // Track whether the chat container is scrolled to the bottom
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distanceFromBottom < 50);
  }, []);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsAtBottom(true);
  }

  // Auto-scroll only when already at the bottom
  useEffect(() => {
    if (isAtBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, status, isAtBottom]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    void sendMessage({ text });
    setInput('');
  }

  const activeModel = selectedModel ?? agentConfig?.model;

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
          {activeModel ? (
            <span
              className="badge badge-info"
              style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}
              title="Active model"
            >
              {activeModel}
            </span>
          ) : (
            <PulsingIndicator />
          )}
          <button
            type="button"
            onClick={() => setShowAgentModal(true)}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              fontSize: '0.8rem',
              padding: '0.3rem 0.7rem',
              whiteSpace: 'nowrap',
            }}
          >
            Model Settings
          </button>
        </div>
      </div>

      {/* Chat window wrapper — position:relative so the scroll button can be anchored */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="card"
          style={{
            height: '100%',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            padding: '1.25rem',
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
                    onClick={() => {
                      void sendMessage({ text: p });
                    }}
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

          {messages.map((message) => (
            <div key={message.id}>
              {/* Role label */}
              <div
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: message.role === 'user' ? 'var(--accent)' : 'var(--text-muted)',
                  marginBottom: '0.3rem',
                }}
              >
                {message.role === 'user' ? 'You' : 'Assistant'}
              </div>

              {message.role === 'user' ? (
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
                  {(message.parts.filter((p) => p.type === 'text') as TextUIPart[])
                    .map((p) => p.text)
                    .join('')}
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
                  {!message.parts.some(
                    (p) => p.type === 'text' || p.type === 'reasoning' || p.type === 'dynamic-tool'
                  ) && loading ? (
                    <span style={{ color: 'var(--text-muted)' }}>Thinking…</span>
                  ) : (
                    message.parts.map((part, i) => {
                      if (part.type === 'reasoning') {
                        return <ReasoningBlock key={i} content={part.text} />;
                      }
                      if (part.type === 'dynamic-tool') {
                        return <ToolCallBlock key={i} part={part as DynamicToolUIPart} />;
                      }
                      if (part.type === 'text') {
                        return <MarkdownRenderer key={i} content={(part as TextUIPart).text} />;
                      }
                      return null;
                    })
                  )}
                </div>
              )}
            </div>
          ))}

          {error && <div className="error-msg">{error.message}</div>}

          <div ref={bottomRef} />
        </div>

        {/* Scroll-to-bottom button */}
        {!isAtBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            style={{
              position: 'absolute',
              bottom: '0.75rem',
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10,
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
              borderRadius: '9999px',
              padding: '0.35rem 1rem',
              fontSize: '0.8rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}
          >
            ↓ Scroll to bottom
          </button>
        )}
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
        {loading ? (
          <button
            type="button"
            onClick={stop}
            style={{
              flexShrink: 0,
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: 'var(--error)',
            }}
          >
            ■ Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()} style={{ flexShrink: 0 }}>
            Send
          </button>
        )}
      </form>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '-0.5rem' }}>
        Press <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line
      </p>

      {/* Model Settings modal */}
      {showAgentModal && (
        <AgentModal
          config={agentConfig}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onClose={() => setShowAgentModal(false)}
        />
      )}
    </div>
  );
}

