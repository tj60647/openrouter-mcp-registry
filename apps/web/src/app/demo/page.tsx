'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import type { TextUIPart, UIMessagePart, UIDataTypes, UITools } from 'ai';
import { getToolName, isStaticToolUIPart, DefaultChatTransport } from 'ai';
import { Wrench } from 'lucide-react';
import MarkdownRenderer from '../../components/MarkdownRenderer';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TOKEN_LIMIT = 128_000;

// Keep the most-recent messages that fit within this byte budget.
// The server hard-limits at 100 KB; leave headroom for the extra body fields.
const MAX_HISTORY_BYTES = 80 * 1024;

function trimMessages<T>(messages: T[]): T[] {
  if (messages.length === 0) return messages;
  const enc = new TextEncoder();
  let trimmed = messages;
  while (trimmed.length > 1) {
    if (enc.encode(JSON.stringify(trimmed)).length <= MAX_HISTORY_BYTES) break;
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function parseMaxTokens(raw: string): number | undefined {
  const v = parseInt(raw, 10);
  return isNaN(v) || v <= 0 ? undefined : v;
}

// ── Chat session persistence (localStorage) ─────────────────────────────────────

const CHAT_STORAGE_KEY = 'demo-chat-sessions-v1';
const MAX_SESSIONS = 30;

interface StoredSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
}

function makeSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptySession(): StoredSession {
  const now = Date.now();
  return { id: makeSessionId(), createdAt: now, updatedAt: now, messages: [] };
}

function loadSessions(): StoredSession[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is StoredSession =>
        !!s && typeof (s as StoredSession).id === 'string' && Array.isArray((s as StoredSession).messages),
    );
  } catch {
    return [];
  }
}

function saveSessions(sessions: StoredSession[]): void {
  const trimmed = sessions.slice(-MAX_SESSIONS);
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage quota exceeded (or unavailable): keep only the most recent chats.
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed.slice(-5)));
    } catch {
      /* give up silently — persistence is best-effort for the demo */
    }
  }
}

/** Short label for a chat: the first user message, truncated. */
function sessionTitle(messages: unknown[]): string {
  for (const m of messages as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>) {
    if (m?.role === 'user') {
      const text = (m.parts ?? [])
        .filter((p) => p?.type === 'text')
        .map((p) => p.text ?? '')
        .join(' ')
        .trim();
      if (text) return text.length > 42 ? `${text.slice(0, 42)}…` : text;
    }
  }
  return 'New chat';
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
  { label: 'Is gpt-4o-mini the latest?', text: 'Is openai/gpt-4o-mini the latest model in the GPT-4o-mini series?' },
  { label: 'Is gpt-5.4 available?', text: 'Is openai/gpt-5.4 available in the registry?' },
  { label: 'Is gpt-6.0 available?', text: 'Is openai/gpt-6.0 available in the registry?' },
  { label: 'Cheapest models', text: 'What are the cheapest models available?' },
  { label: '128k context models', text: 'Find models with at least 128k context window' },
  { label: 'Compare Claude vs GPT-4o', text: 'Compare anthropic/claude-sonnet-4-5 and openai/gpt-4o' },
  { label: 'Registry status', text: 'When was the registry last synced?' },
  { label: 'Build poetry writing agent', text: 'I need to build a poetry writing agent. What is the latest model from Google available in the registry? Give me a recommended model ID, a system prompt, and suggested temperature and max token settings — and show me a short TypeScript example using the Vercel AI SDK that wires it all together.' },
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
    <div style={{ border: '1px solid var(--border)', borderRadius: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: open ? 'var(--bg-hover)' : 'transparent',
          border: 'none',
          color: 'var(--text)',
          padding: '0.4rem 0.6rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '0.8rem',
          // Holds a code identifier — opt out of the global uppercase button type.
          textTransform: 'none',
          letterSpacing: 'normal',
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
          // Let the global input/select rule supply the border, fill and radius.
          style={{
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
          style={{ padding: '0.4rem 0.6rem', fontSize: '0.8rem' }}
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
              fontSize: '0.72rem',
              lineHeight: 1.5,
              margin: 0,
              color: 'var(--text)',
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
          <div
            // Studio red recipe (AdminLayout.tsx:138): red-300 border, red-50
            // fill, red-700 text — never a low-alpha tint on white.
            style={{
              border: '1px solid var(--error-border)',
              borderRadius: 0,
              padding: '0.5rem 0.65rem',
              background: 'var(--error-bg)',
            }}
          >
            <p
              style={{
                color: 'var(--error-text)',
                fontSize: '0.8rem',
                margin: '0 0 0.25rem',
                fontWeight: 600,
              }}
            >
              ✗ MCP not connected
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: 0, lineHeight: 1.4 }}>
              Set <code style={{ fontSize: '0.72rem' }}>MCP_URL</code> in{' '}
              <code style={{ fontSize: '0.72rem' }}>apps/web/.env.local</code> and restart the
              dev server. The chatbot will answer without live registry tools until this is
              configured.
            </p>
          </div>
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
      // Studio renders this as a <details> under a border-t border-gray-200 with
      // a 10px bold uppercase tracking-widest summary — no colour, just hairlines.
      style={{
        margin: '0.4rem 0',
        border: '1px solid var(--border)',
        borderRadius: 0,
        overflow: 'hidden',
        fontSize: '0.85rem',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'var(--bg-hover)',
          border: 'none',
          color: 'var(--text-muted)',
          padding: '0.35rem 0.75rem',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.625rem',
          fontWeight: 700,
          letterSpacing: '0.12em',
        }}
      >
        <span
          style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none' }}
        >
          ▶
        </span>
        Reasoning
        {!open && wordCount > 0 && (
          <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: '0.625rem' }}>
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
            background: 'var(--bg)',
            borderTop: '1px solid var(--border)',
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

// ── ToolCallBlock ─────────────────────────────────────────────────────────────

// Union of static (tool-NAME) and dynamic (dynamic-tool) tool part shapes
type ToolPartFull = UIMessagePart<UIDataTypes, UITools> & {
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown> | string | unknown;
  output?: unknown;
  errorText?: string;
  state?: string;
};

function ToolCallBlock({ part }: { part: UIMessagePart<UIDataTypes, UITools> }) {
  const [open, setOpen] = useState(false);
  const p = part as ToolPartFull;
  const isError = p.state === 'output-error';
  const isDone = p.state === 'output-available' || isError;
  const isRunning = !isDone;
  const displayName = isStaticToolUIPart(part as Parameters<typeof isStaticToolUIPart>[0])
    ? getToolName(part as Parameters<typeof getToolName>[0])
    : (p.toolName ?? '?');

  const argsStr =
    p.input !== undefined
      ? typeof p.input === 'string'
        ? p.input
        : JSON.stringify(p.input, null, 2)
      : null;

  const resultStr =
    p.output !== undefined
      ? typeof p.output === 'string'
        ? p.output
        : JSON.stringify(p.output, null, 2)
      : null;

  const hasDetails = (argsStr && argsStr !== '{}') || resultStr || p.errorText;

  return (
    <div
      style={{
        fontSize: '0.8rem',
        border: `1px solid ${isError ? 'var(--error-border)' : 'var(--border)'}`,
        borderRadius: 0,
        margin: '0.3rem 0',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        style={{
          width: '100%',
          background: isError ? 'var(--error-bg)' : open ? 'var(--bg-hover)' : 'transparent',
          border: 'none',
          color: isError ? 'var(--error-text)' : 'var(--text-muted)',
          padding: '0.35rem 0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          cursor: hasDetails ? 'pointer' : 'default',
          textAlign: 'left',
          fontSize: '0.8rem',
          // Holds a code identifier — opt out of the global uppercase button type.
          textTransform: 'none',
          letterSpacing: 'normal',
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
          <span style={{ fontSize: '0.9rem', color: 'var(--error-text)', flexShrink: 0 }}>✗</span>
        ) : (
          <span style={{ fontSize: '0.9rem', color: 'var(--success-text)', flexShrink: 0 }}>✓</span>
        )}
        <span>
          Tool: <code style={{ fontSize: '0.78rem' }}>{displayName}</code>
        </span>
        {hasDetails && (
          <span
            style={{
              marginLeft: 'auto',
              transition: 'transform 0.15s',
              transform: open ? 'rotate(90deg)' : 'none',
              color: 'var(--text-faint)',
              fontSize: '0.7rem',
            }}
          >
            ▶
          </span>
        )}
        {isRunning && (
          <span
            style={{
              marginLeft: hasDetails ? '0.25rem' : 'auto',
              color: 'var(--text-faint)',
            }}
          >
            running…
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            padding: '0.5rem 0.75rem',
            borderTop: `1px solid ${isError ? 'var(--error-border)' : 'var(--border)'}`,
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
  const [temperature, setTemperature] = useState(0);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>(undefined);
  const [showPanel, setShowPanel] = useState(false);

  const chatBody = useMemo(
    () => ({
      ...(selectedModel ? { model: selectedModel } : {}),
      temperature,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    }),
    [selectedModel, temperature, maxOutputTokens]
  );

  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      prepareSendMessagesRequest: ({ messages, body }) => ({
        body: { ...(body ?? {}), messages: trimMessages(messages) },
      }),
    }),
  });

  const [input, setInput] = useState('');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const loading = status === 'submitted' || status === 'streaming';

  // ── Persisted chat sessions (localStorage) ──────────────────────────────────
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const hydratedRef = useRef(false);
  const skipSaveRef = useRef(false);

  // Load saved sessions once on mount and open the most recent.
  useEffect(() => {
    let loaded = loadSessions();
    if (loaded.length === 0) loaded = [emptySession()];
    const idx = loaded.length - 1;
    setSessions(loaded);
    setCurrentIndex(idx);
    skipSaveRef.current = true;
    setMessages(loaded[idx].messages as Parameters<typeof setMessages>[0]);
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active session whenever its messages change.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    setSessions((prev) => {
      if (prev.length === 0) return prev;
      const idx = Math.min(currentIndex, prev.length - 1);
      const next = prev.slice();
      next[idx] = { ...next[idx], messages: messages as unknown[], updatedAt: Date.now() };
      saveSessions(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const switchTo = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= sessions.length || idx === currentIndex) return;
      if (loading) stop();
      skipSaveRef.current = true;
      setCurrentIndex(idx);
      setMessages(sessions[idx].messages as Parameters<typeof setMessages>[0]);
    },
    [sessions, currentIndex, loading, stop, setMessages],
  );

  const newChat = useCallback(() => {
    if (loading) stop();
    // Don't pile up empty chats — if the current one is untouched, just stay on it.
    if (messages.length === 0 && sessions.length > 0) return;
    const fresh = emptySession();
    const next = [...sessions, fresh].slice(-MAX_SESSIONS);
    saveSessions(next);
    setSessions(next);
    setCurrentIndex(next.length - 1);
    skipSaveRef.current = true;
    setMessages([] as Parameters<typeof setMessages>[0]);
  }, [loading, stop, messages.length, sessions, setMessages]);

  const deleteCurrent = useCallback(() => {
    if (loading) stop();
    const idx = Math.min(currentIndex, sessions.length - 1);
    let next = sessions.filter((_, i) => i !== idx);
    if (next.length === 0) next = [emptySession()];
    const newIdx = Math.min(idx, next.length - 1);
    saveSessions(next);
    setSessions(next);
    setCurrentIndex(newIdx);
    skipSaveRef.current = true;
    setMessages(next[newIdx].messages as Parameters<typeof setMessages>[0]);
  }, [loading, stop, currentIndex, sessions, setMessages]);

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

  /** Short display label for the active model, e.g. "gpt-4o-mini" */
  const modelLabel = activeModel ? activeModel.split('/').pop() || activeModel : 'Assistant';

  const chatTitle = messages.length > 0 ? sessionTitle(messages as unknown[]) : 'New chat';
  // --border was previously used as a TEXT colour here; at #e0e0e0 the disabled
  // chevrons were white-on-white. Use the studio's disabled label tone instead.
  const navBtnStyle = (disabled: boolean): React.CSSProperties => ({
    background: 'transparent',
    border: '1px solid var(--border-control)',
    color: disabled ? 'var(--disabled-text)' : 'var(--text)',
    fontSize: '1.05rem',
    lineHeight: 1,
    padding: '0.2rem 0.6rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
  });

  // 6.75rem === 44px sticky nav + 2rem top/bottom main padding.
  return (
    <div className="stack" style={{ height: 'calc(100vh - 6.75rem)', maxHeight: 900 }}>
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
            Imagine you are an AI agent whose job is to build another agent — this assistant knows
            the live model registry and can help you pick the right model, write a system prompt,
            and configure parameters for any agent you want to create.
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
              style={{
                whiteSpace: 'nowrap',
                fontSize: '0.7rem',
                fontFamily: 'var(--mono)',
                textTransform: 'none',
                letterSpacing: 'normal',
              }}
            >
              {activeModel}
            </span>
          ) : (
            <PulsingIndicator label="Loading model" />
          )}
          {/* Studio toggle pair: active = solid black, inactive = ghost. */}
          <button
            type="button"
            className={showPanel ? undefined : 'btn-ghost'}
            onClick={() => setShowPanel((p) => !p)}
            style={{
              fontSize: '0.625rem',
              padding: '0.4rem 0.7rem',
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
          {/* Chat history toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={newChat}
              title="Start a new chat"
              className="btn-ghost"
              style={{ padding: '0.35rem 0.7rem', whiteSpace: 'nowrap' }}
            >
              ＋ New chat
            </button>

            <div style={{ flex: 1 }} />

            <button
              type="button"
              onClick={() => switchTo(currentIndex - 1)}
              disabled={currentIndex <= 0}
              aria-label="Previous chat"
              title="Previous chat"
              style={navBtnStyle(currentIndex <= 0)}
            >
              ‹
            </button>
            <span
              title={chatTitle}
              style={{
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              Chat {sessions.length > 0 ? currentIndex + 1 : 0} / {sessions.length}
              {chatTitle !== 'New chat' ? ` · ${chatTitle}` : ''}
            </span>
            <button
              type="button"
              onClick={() => switchTo(currentIndex + 1)}
              disabled={currentIndex >= sessions.length - 1}
              aria-label="Next chat"
              title="Next chat"
              style={navBtnStyle(currentIndex >= sessions.length - 1)}
            >
              ›
            </button>
            <button
              type="button"
              onClick={deleteCurrent}
              aria-label="Delete this chat"
              title="Delete this chat"
              className="btn-ghost"
              style={{ fontSize: '0.85rem', padding: '0.25rem 0.55rem', lineHeight: 1 }}
            >
              🗑
            </button>
          </div>

          {/* Chat window */}
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="card"
              // Studio chat scroller sits on bg-[#fafafa] so white bubbles read.
              style={{
                height: '100%',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem',
                padding: '1.25rem',
                background: 'var(--bg-surface)',
              }}
            >
              {messages.length === 0 && !loading && (
                <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <p style={{ marginBottom: '0.5rem', fontSize: '0.95rem' }}>
                    Imagine you&apos;re an agent that needs to build another agent.
                  </p>
                  <p style={{ marginBottom: '0.75rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Ask me to find the best model, write a system prompt, or configure parameters
                    for any kind of agent you want to create. Try the chips below to get started ↓
                  </p>
                </div>
              )}

              {messages.map((message) => {
                const isUser = message.role === 'user';
                return (
                  <div
                    key={message.id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: isUser ? 'flex-end' : 'flex-start',
                    }}
                  >
                    {/* Role label */}
                    <div
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: isUser ? 'var(--accent)' : 'var(--text-muted)',
                        marginBottom: '0.25rem',
                        paddingLeft: isUser ? 0 : '0.25rem',
                        paddingRight: isUser ? '0.25rem' : 0,
                      }}
                    >
                      {isUser ? 'You' : 'Assistant'}
                    </div>

                    {isUser ? (
                      // Studio bubble pair (ChatInterface.tsx:156-160): user is a
                      // solid black fill, assistant is white with a hairline.
                      // Corners are squared per the spec's zero-radius rule.
                      <div
                        style={{
                          background: 'var(--accent)',
                          border: '1px solid var(--accent)',
                          borderRadius: 0,
                          color: '#fff',
                          padding: '0.6rem 0.9rem',
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.6,
                          fontSize: '0.875rem',
                          maxWidth: '80%',
                        }}
                      >
                        {(message.parts.filter((p) => p.type === 'text') as TextUIPart[])
                          .map((p) => p.text)
                          .join('')}
                      </div>
                    ) : (
                      <>
                        <div
                          style={{
                            background: 'var(--bg)',
                            border: '1px solid var(--border)',
                            borderRadius: 0,
                            padding: '0.75rem 1rem',
                            lineHeight: 1.6,
                            fontSize: '0.875rem',
                            maxWidth: '90%',
                            minWidth: 0,
                          }}
                        >
                          {!message.parts.some(
                            (p) =>
                              p.type === 'text' ||
                              p.type === 'reasoning' ||
                              p.type === 'dynamic-tool' ||
                              isStaticToolUIPart(p as Parameters<typeof isStaticToolUIPart>[0])
                          ) && loading ? (
                            <div style={{ padding: '0.25rem 0' }}>
                              <PulsingIndicator label="Thinking" />
                            </div>
                          ) : (
                            message.parts.map((part, i) => {
                              if (part.type === 'reasoning') {
                                return <ReasoningBlock key={i} content={part.text} />;
                              }
                              if (part.type === 'dynamic-tool' || isStaticToolUIPart(part as Parameters<typeof isStaticToolUIPart>[0])) {
                                return <ToolCallBlock key={i} part={part} />;
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
                        {/* Tools-used + model footer */}
                        {(() => {
                          const toolParts = message.parts.filter(
                            (p) => p.type === 'dynamic-tool' || isStaticToolUIPart(p as Parameters<typeof isStaticToolUIPart>[0])
                          );
                          const uniqueTools = [
                            ...new Set(toolParts.map((p) => getToolName(p as Parameters<typeof getToolName>[0]))),
                          ];
                          return (
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                flexWrap: 'wrap',
                                gap: '0.3rem',
                                marginTop: '0.3rem',
                                paddingLeft: '0.35rem',
                              }}
                            >
                              {uniqueTools.map((name) => (
                                <span
                                  key={name}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    fontSize: '0.65rem',
                                    fontFamily: 'var(--mono)',
                                    color: 'var(--text)',
                                    background: 'var(--bg-hover)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 0,
                                    padding: '0.1rem 0.45rem',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  <Wrench size={9} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden />
                                  {name}
                                </span>
                              ))}
                              {modelLabel && (
                                <span
                                  style={{
                                    fontSize: '0.65rem',
                                    color: 'var(--text-faint)',
                                    fontFamily: 'var(--mono)',
                                    marginLeft: uniqueTools.length > 0 ? '0.15rem' : 0,
                                  }}
                                >
                                  {modelLabel}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </div>
                );
              })}

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
                // Flat: the drop shadow was the only elevation in the app and
                // the spec bans shadows — a black hairline carries it instead.
                style={{
                  position: 'absolute',
                  bottom: '0.75rem',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 10,
                  background: 'var(--bg)',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text)',
                  borderRadius: 0,
                  padding: '0.35rem 1rem',
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
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
              <button type="button" className="btn-danger" onClick={stop} style={{ flexShrink: 0 }}>
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

          {/* Persistent example prompt chips */}
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              flexWrap: 'wrap',
            }}
          >
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p.label}
                type="button"
                disabled={loading}
                onClick={() => {
                  void sendMessage({ text: p.text }, { body: chatBody });
                }}
                // Studio quick prompts: bg-gray-100, 10px bold uppercase,
                // square, disabled expressed as colour rather than opacity.
                style={{
                  flexShrink: 0,
                  background: loading ? 'var(--disabled-bg)' : 'var(--bg-hover)',
                  border: '1px solid var(--border)',
                  color: loading ? 'var(--disabled-text)' : 'var(--text)',
                  borderRadius: 0,
                  padding: '0.35rem 0.75rem',
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
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
