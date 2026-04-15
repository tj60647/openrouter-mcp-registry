import { describe, it, expect } from 'vitest';
import { InMemoryAliasService, SYSTEM_ALIASES } from '../services/aliasService';

describe('InMemoryAliasService', () => {
  it('resolves known system alias', async () => {
    const svc = new InMemoryAliasService();
    const result = await svc.resolveAlias('auto');
    expect(result).toBe('openrouter/auto');
  });

  it('resolves sonnet alias', async () => {
    const svc = new InMemoryAliasService();
    const result = await svc.resolveAlias('sonnet');
    expect(result).toBe(SYSTEM_ALIASES['sonnet']);
  });

  it('returns null for unknown alias', async () => {
    const svc = new InMemoryAliasService();
    const result = await svc.resolveAlias('unknown-alias-xyz');
    expect(result).toBeNull();
  });

  it('resolves extra aliases passed in constructor', async () => {
    const svc = new InMemoryAliasService({ 'my-model': 'openai/gpt-4o' });
    const result = await svc.resolveAlias('my-model');
    expect(result).toBe('openai/gpt-4o');
  });

  it('trims whitespace on input', async () => {
    const svc = new InMemoryAliasService();
    const result = await svc.resolveAlias('  auto  ');
    expect(result).toBe('openrouter/auto');
  });
});
