'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import type { DynamicToolUIPart, TextUIPart } from 'ai';
import MarkdownRenderer from '../../components/MarkdownRenderer';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TOKEN_LIMIT = 128_000;

function parseMaxTokens(raw: string): number | undefined {
  const v = parseInt(raw, 10);
  return isNaN(v) || v <= 0 ? undefined : v;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentTool {
  name: string;
  description: string;
}

interface AgentConfig {
  model: string;
  systemPrompt: string;
  parameters: Record<string, unknown>;
  availableModels: string[];
  tools: AgentTool[];
}

// ── Example prompts ───────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  'What are the cheapest models available?',
  'Compare anthropic/claude-sonnet-4-5 and openai/gpt-4o',
  'Find models with at least 128k context window',
  'What Anthropic models are in the registry?',
  'When was the registry last synced?',
];

// ── PulsingIndicator ──────────────────────────────────────────────────────────

function PulsingIndicator({ label = 'Loading' }: { label?: string }) {
  return (
    <svg
      width="36"
      height="12"
      viewBox="0 0 36 12"
      aria-label={label}
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

// ── SectionLabel ──────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.7rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--text-muted)',
        marginBottom: '0.4rem',
      }}
    >
      {children}
    </div>
  );
}

// ── ToolCard (agent panel) ────────────────────────────────────────────────────

function ToolCard({ tool }: { tool: AgentTool }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: open ? 'rgba(99,102,241,0.08)' : 'none',
          border: 'none',
          color: 'var(--text)',
          padding: '0.4rem 0.6rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '0.8rem',
        }}
      >
        <span
          style={{
            color: 'var(--accent)',
            fontSize: '0.7rem',
            transition: 'transform 0.15s',
            transform: open ? 'rotate(90deg)' : 'none',
            flexShrink: 0,
          }}
        >
          ▶
        </span>
        <code style={{ fontSize: '0.78rem' }}>{tool.name}</code>
      </button>
      {open && tool.description && (
        <div
          style={{
            padding: '0.4rem 0.6rem',
            fontSize: '0.78rem',
            color: 'var(--text-muted)',
            borderTop: '1px solid var(--border)',
            lineHeight: 1.5,
          }}
        >
          {tool.description}
        </div>
      )}
    </div>
  );
}

// ── AgentPanel (sidebar) ──────────────────────────────────────────────────────

function AgentPanel({
  config,
  selectedModel,
  temperature,
  maxOutputTokens,
  onModelChange,
  onTemperatureChange,
  onMaxOutputTokensChange,
}: {
  config: AgentConfig | null;
  selectedModel: string | null;
  temperature: number;
  maxOutputTokens: number | undefined;
  onModelChange: (m: string) => void;
  onTemperatureChange: (t: number) => void;
  onMaxOutputTokensChange: (t: number | undefined) => void;
}) {
  const [systemOpen, setSystemOpen] = useState(false);

  if (config === null) {
    return (
      <div
        className="card"
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PulsingIndicator label="Loading agent configuration" />
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        height: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
        padding: '1rem',
        fontSize: '0.875rem',
      }}
    >
      {/* Model */}
      <div>
        <SectionLabel>Model</SectionLabel>
        <select
          value={selectedModel ?? config.model}
          onChange={(e) => onModelChange(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            borderRadius: 6,
            padding: '0.4rem 0.6rem',
            fontSize: '0.8rem',
            fontFamily: 'var(--mono)',
          }}
        >
          {[
            ...new Set([
              ...(selectedModel !== null && !config.availableModels.includes(selectedModel)
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

      {/* Temperature */}
      <div>
        <SectionLabel>Temperature — {temperature.toFixed(2)}</SectionLabel>
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={temperature}
          onChange={(e) => onTemperatureChange(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--accent)', display: 'block' }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.68rem',
            color: 'var(--text-muted)',
            marginTop: '0.15rem',
          }}
        >
          <span>0 precise</span>
          <span>2 creative</span>
        </div>
      </div>

      {/* Max Tokens */}
      <div>
        <SectionLabel>Max Tokens</SectionLabel>
        <input
          type="number"
          min={1}
          max={MAX_TOKEN_LIMIT}
          step={256}
          placeholder="Model default"
          value={maxOutputTokens ?? ''}
          onChange={(e) => onMaxOutputTokensChange(parseMaxTokens(e.target.value))}
          style={{
            width: '100%',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            borderRadius: 6,
            padding: '0.4rem 0.6rem',
            fontSize: '0.85rem',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* System Prompt (collapsible) */}
      <div>
        <button
          type="button"
          onClick={() => setSystemOpen((o) => !o)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            padding: 0,
            cursor: 'pointer',
            fontSize: '0.7rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: systemOpen ? '0.4rem' : 0,
          }}
        >
          <span
            style={{
              transition: 'transform 0.15s',
              transform: systemOpen ? 'rotate(90deg)' : 'none',
            }}
          >
            ▶
          </span>
          System Prompt
        </button>
        {systemOpen && (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: '0.78rem',
              lineHeight: 1.5,
              margin: 0,
              color: 'var(--text-muted)',
            }}
          >
            {config.systemPrompt}
          </pre>
        )}
      </div>

      {/* Tools */}
      <div>
        <SectionLabel>
          Tools{config.tools.length > 0 ? ` (${config.tools.length})` : ''}
        </SectionLabel>
        {config.tools.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>
            No tools loaded
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {config.tools.map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ReasoningBlock ────────────────────────────────────────────────────────────

function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const wordCount = content.split(/\s+/).filter(Boolean).length;
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
        <span
          style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none' }}
        >
          ▶
        </span>
        Reasoning
        {!open && wordCount > 0 && (
          <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>
            {wordCount} words
          </span>
        )}
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

// Extend the base type to access runtime-available fields
type ToolPartFull = DynamicToolUIPart & {
  args?: Record<string, unknown> | string;
  result?: unknown;
  errorText?: string;
};

function ToolCallBlock({ part }: { part: DynamicToolUIPart }) {
  const [open, setOpen] = useState(false);
  const p = part as ToolPartFull;
  const isError = part.state === 'output-error';
  const isDone = part.state === 'output-available' || isError;
  const isRunning = !isDone;

  const argsStr =
    p.args !== undefined
      ? typeof p.args === 'string'
        ? p.args
        : JSON.stringify(p.args, null, 2)
      : null;

  const resultStr =
    p.result !== undefined
      ? typeof p.result === 'string'
        ? p.result
        : JSON.stringify(p.result, null, 2)
      : null;

  const hasDetails = (argsStr && argsStr !== '{}') || resultStr || p.errorText;

  return (
    <div
      style={{
        fontSize: '0.8rem',
        border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(99,102,241,0.2)'}`,
        borderRadius: 6,
        margin: '0.3rem 0',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        style={{
          width: '100%',
          background: open ? 'rgba(99,102,241,0.1)' : 'rgba(99,102,241,0.05)',
          border: 'none',
          color: isError ? 'var(--error)' : 'var(--text-muted)',
          padding: '0.35rem 0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          cursor: hasDetails ? 'pointer' : 'default',
          textAlign: 'left',
          fontSize: '0.8rem',
        }}
      >
        {/* Animated spinner while running */}
        {isRunning ? (
          <svg width="14" height="14" viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
            <circle
              cx="7"
              cy="7"
              r="5"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeDasharray="20"
              strokeLinecap="round"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 7 7"
                to="360 7 7"
                dur="0.9s"
                repeatCount="indefinite"
              />
            </circle>
          </svg>
        ) : isError ? (
          <span style={{ fontSize: '0.9rem', color: 'var(--error)', flexShrink: 0 }}>✗</span>
        ) : (
          <span style={{ fontSize: '0.9rem', color: 'var(--success)', flexShrink: 0 }}>✓</span>
        )}
        <span>
          Tool: <code style={{ fontSize: '0.78rem' }}>{part.toolName}</code>
        </span>
        {hasDetails && (
          <span
            style={{
              marginLeft: 'auto',
              transition: 'transform 0.15s',
              transform: open ? 'rotate(90deg)' : 'none',
              opacity: 0.5,
              fontSize: '0.7rem',
            }}
          >
            ▶
          </span>
        )}
        {isRunning && (
          <span style={{ marginLeft: hasDetails ? '0.25rem' : 'auto', opacity: 0.5 }}>
            running…
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            padding: '0.5rem 0.75rem',
            borderTop: `1px solid ${isError ? 'rgba(239,68,68,0.2)' : 'rgba(99,102,241,0.15)'}`,
            background: 'var(--bg)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          {argsStr && argsStr !== '{}' && (
            <div>
              <div
                style={{
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-muted)',
                  marginBottom: '0.25rem',
                }}
              >
                Arguments
              </div>
              <pre
                style={{
                  margin: 0,
                  fontSize: '0.75rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 150,
                  overflowY: 'auto',
                }}
              >
                {argsStr}
              </pre>
            </div>
          )}
          {resultStr && (
            <div>
              <div
                style={{
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-muted)',
                  marginBottom: '0.25rem',
                }}
              >
                Result
              </div>
              <pre
                style={{
                  margin: 0,
                  fontSize: '0.75rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 200,
                  overflowY: 'auto',
                }}
              >
                {resultStr}
              </pre>
            </div>
          )}
          {p.errorText && (
            <div className="error-msg" style={{ padding: '0.4rem', fontSize: '0.8rem' }}>
              {p.errorText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DemoPage() {
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [temperature, setTemperature] = useState(1.0);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>(undefined);
  const [showPanel, setShowPanel] = useState(true);

  const chatBody = useMemo(
    () => ({
      ...(selectedModel ? { model: selectedModel } : {}),
      temperature,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    }),
    [selectedModel, temperature, maxOutputTokens]
  );

  const { messages, sendMessage, status, error, stop } = useChat();

  const [input, setInput] = useState('');
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

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
  }, []);

  useEffect(() => {
    if (isAtBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status, isAtBottom]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    void sendMessage({ text }, { body: chatBody });
    setInput('');
  }

  const activeModel = selectedModel ?? agentConfig?.model;

  return (
    <div className="stack" style={{ height: 'calc(100vh - 8rem)', maxHeight: 900 }}>
      {/* Page header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div>
          <h1>Live Demo</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Chat with an AI assistant backed by live MCP registry tools.
          </p>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            flexShrink: 0,
            paddingTop: '0.35rem',
          }}
        >
          {activeModel ? (
            <span
              className="badge badge-info"
              style={{ whiteSpace: 'nowrap', fontSize: '0.75rem' }}
            >
              {activeModel}
            </span>
          ) : (
            <PulsingIndicator label="Loading model" />
          )}
          <button
            type="button"
            onClick={() => setShowPanel((p) => !p)}
            style={{
              background: showPanel ? 'rgba(99,102,241,0.15)' : 'none',
              border: '1px solid var(--border)',
              color: showPanel ? 'var(--accent)' : 'var(--text-muted)',
              fontSize: '0.8rem',
              padding: '0.3rem 0.7rem',
              whiteSpace: 'nowrap',
            }}
          >
            {showPanel ? '⊟' : '⊞'} Agent
          </button>
        </div>
      </div>

      {/* Two-column layout: chat | agent panel */}
      <div style={{ display: 'flex', gap: '1rem', flex: 1, minHeight: 0 }}>
        {/* Chat column */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            minWidth: 0,
          }}
        >
          {/* Chat window */}
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
                  <p style={{ marginBottom: '1.25rem', fontSize: '0.95rem' }}>
                    Try one of these prompts:
                  </p>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                      alignItems: 'center',
                    }}
                  >
                    {EXAMPLE_PROMPTS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          void sendMessage({ text: p }, { body: chatBody });
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
                        (p) =>
                          p.type === 'text' || p.type === 'reasoning' || p.type === 'dynamic-tool'
                      ) && loading ? (
                        <div style={{ padding: '0.25rem 0' }}>
                          <PulsingIndicator label="Thinking" />
                        </div>
                      ) : (
                        message.parts.map((part, i) => {
                          if (part.type === 'reasoning') {
                            return <ReasoningBlock key={i} content={part.text} />;
                          }
                          if (part.type === 'dynamic-tool') {
                            return <ToolCallBlock key={i} part={part as DynamicToolUIPart} />;
                          }
                          if (part.type === 'text') {
                            return (
                              <MarkdownRenderer key={i} content={(part as TextUIPart).text} />
                            );
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
                onClick={() => {
                  bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
                  setIsAtBottom(true);
                }}
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
                  if (input.trim()) e.currentTarget.form?.requestSubmit();
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
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '-0.25rem' }}>
            Press <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for a new line
          </p>
        </div>

        {/* Agent panel (sidebar) */}
        {showPanel && (
          <div style={{ width: 280, flexShrink: 0 }}>
            <AgentPanel
              config={agentConfig}
              selectedModel={selectedModel}
              temperature={temperature}
              maxOutputTokens={maxOutputTokens}
              onModelChange={setSelectedModel}
              onTemperatureChange={setTemperature}
              onMaxOutputTokensChange={setMaxOutputTokens}
            />
          </div>
        )}
      </div>
    </div>
  );
}
