import { describe, it, expect } from 'vitest';
import { ModelRegistry } from '../services/modelRegistry';
import type { ModelLookup } from '../services/modelRegistry';
import type { Model } from '../types/model';

const fakeModel: Model = {
  id: 'openai/gpt-4o',
  provider: 'openai',
  displayName: 'GPT-4o',
  contextLength: 128000,
  inputPricePer1k: 0.005,
  outputPricePer1k: 0.015,
  metadata: {},
  fetchedAt: new Date(),
};

describe('ModelRegistry', () => {
  const makeRegistry = (findById: (id: string) => Promise<Model | null>) => {
    const modelLookup: ModelLookup = { findById };
    return new ModelRegistry(modelLookup);
  };

  it('resolves canonical ID directly', async () => {
    const registry = makeRegistry(async () => fakeModel);
    const result = await registry.resolve('openai/gpt-4o');
    expect(result.source).toBe('canonical');
    expect(result.resolved).toBe('openai/gpt-4o');
    expect(result.model).toEqual(fakeModel);
  });

  it('returns source=normalized for unknown non-canonical input', async () => {
    const registry = makeRegistry(async () => null);
    const result = await registry.resolve('unknown-thing');
    expect(result.source).toBe('normalized');
    expect(result.model).toBeNull();
  });
});
