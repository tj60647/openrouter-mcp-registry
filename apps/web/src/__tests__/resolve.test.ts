import { describe, it, expect } from 'vitest';
import { SYSTEM_ALIASES, InMemoryAliasService, ModelRegistry } from '@openrouter-mcp/shared';
import type { Model } from '@openrouter-mcp/shared';

const fakeModel: Model = {
  id: 'anthropic/claude-sonnet-4-5',
  provider: 'anthropic',
  displayName: 'Claude Sonnet 4.5',
  contextLength: 200000,
  inputPricePer1k: null,
  outputPricePer1k: null,
  metadata: {},
  fetchedAt: new Date(),
};

/**
 * Mirrors the resolution logic used in apps/web/src/app/api/resolve/route.ts
 */
async function resolveModel(input: string, dbAliases: Record<string, string> = {}) {
  const combinedAliases = { ...SYSTEM_ALIASES, ...dbAliases };
  const aliasService = new InMemoryAliasService(combinedAliases);
  const registry = new ModelRegistry(
    {
      findById: async (id) => (id === fakeModel.id ? fakeModel : null),
    },
    aliasService
  );
  return registry.resolve(input);
}

describe('web resolve endpoint logic', () => {
  it('resolves sonnet alias to anthropic model', async () => {
    const result = await resolveModel('sonnet');
    expect(result.source).toBe('alias');
    expect(result.resolved).toBe(SYSTEM_ALIASES['sonnet']);
    expect(result.model).toEqual(fakeModel);
  });

  it('resolves canonical ID directly', async () => {
    const result = await resolveModel('anthropic/claude-sonnet-4-5');
    expect(result.source).toBe('canonical');
    expect(result.resolved).toBe('anthropic/claude-sonnet-4-5');
  });

  it('resolves db alias when provided', async () => {
    const result = await resolveModel('my-alias', {
      'my-alias': 'anthropic/claude-sonnet-4-5',
    });
    expect(result.source).toBe('alias');
    expect(result.resolved).toBe('anthropic/claude-sonnet-4-5');
  });

  it('returns normalized for unknown input without slash', async () => {
    const result = await resolveModel('nonexistent-model');
    expect(result.source).toBe('normalized');
    expect(result.model).toBeNull();
  });

  it('resolves auto alias', async () => {
    const result = await resolveModel('auto');
    expect(result.resolved).toBe('openrouter/auto');
    expect(result.source).toBe('alias');
  });
});
