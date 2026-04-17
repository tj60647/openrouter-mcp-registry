import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '@openrouter-mcp/shared';
import type { Model } from '@openrouter-mcp/shared';

const fakeModel: Model = {
  id: 'anthropic/claude-sonnet-4-5',
  provider: 'anthropic',
  displayName: 'Claude Sonnet 4.5',
  description: null,
  modality: null,
  contextLength: 200000,
  maxCompletionTokens: null,
  inputPricePer1k: null,
  outputPricePer1k: null,
  imagePricePer1k: null,
  createdAt: null,
  metadata: {},
  fetchedAt: new Date(),
};

/**
 * Mirrors the resolution logic used in apps/web/src/app/api/resolve/route.ts
 */
async function resolveModel(input: string) {
  const registry = new ModelRegistry({
    findById: async (id) => (id === fakeModel.id ? fakeModel : null),
  });
  return registry.resolve(input);
}

describe('web resolve endpoint logic', () => {
  it('resolves canonical ID directly', async () => {
    const result = await resolveModel('anthropic/claude-sonnet-4-5');
    expect(result.source).toBe('canonical');
    expect(result.resolved).toBe('anthropic/claude-sonnet-4-5');
    expect(result.model).toEqual(fakeModel);
  });

  it('returns normalized for unknown input without slash', async () => {
    const result = await resolveModel('nonexistent-model');
    expect(result.source).toBe('normalized');
    expect(result.model).toBeNull();
  });
});
