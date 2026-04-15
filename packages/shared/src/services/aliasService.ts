import { canonicalizeModelId } from './canonicalize';

export const SYSTEM_ALIASES: Record<string, string> = {
  auto: 'openrouter/auto',
  sonnet: 'anthropic/claude-sonnet-4-5',
  haiku: 'anthropic/claude-haiku-4-5',
  opus: 'anthropic/claude-opus-4-5',
  'gpt-4o': 'openai/gpt-4o',
  'gpt-4': 'openai/gpt-4',
  'gpt-3.5': 'openai/gpt-3.5-turbo',
  'fast-general': 'anthropic/claude-haiku-4-5',
  'best-general': 'anthropic/claude-sonnet-4-5',
  gemini: 'google/gemini-pro-1.5',
  mistral: 'mistralai/mistral-large',
};

export interface AliasLookup {
  resolveAlias(alias: string): Promise<string | null>;
}

export class InMemoryAliasService implements AliasLookup {
  private readonly extraAliases: Map<string, string>;

  constructor(extraAliases: Record<string, string> = {}) {
    this.extraAliases = new Map(Object.entries(extraAliases));
  }

  async resolveAlias(alias: string): Promise<string | null> {
    const normalized = canonicalizeModelId(alias);
    return (
      SYSTEM_ALIASES[normalized] ?? this.extraAliases.get(normalized) ?? null
    );
  }
}
