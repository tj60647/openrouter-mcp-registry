import { describe, it, expect, vi } from 'vitest';
import { ModelSyncService } from '../services/modelSync';
import type { ModelRepository } from '../services/modelSync';
import type { ModelProvider, ProviderModel } from '../types/provider';

const makeProvider = (models: ProviderModel[]): ModelProvider => ({
  name: 'test',
  fetchModels: async () => models,
});

const makeRepository = (): ModelRepository & {
  upserted: unknown[];
  attempts: { success: boolean; error?: string }[];
} => {
  const upserted: unknown[] = [];
  const attempts: { success: boolean; error?: string }[] = [];
  let locked = false;
  return {
    upserted,
    attempts,
    async upsertModels(models) {
      upserted.push(...models);
    },
    async recordSyncAttempt(success, error) {
      attempts.push({ success, error });
    },
    async acquireSyncLock() {
      if (locked) return false;
      locked = true;
      return true;
    },
    async releaseSyncLock() {
      locked = false;
    },
  };
};

describe('ModelSyncService', () => {
  it('syncs models successfully', async () => {
    const provider = makeProvider([
      { id: 'openai/gpt-4o', name: 'GPT-4o', contextLength: 128000 },
    ]);
    const repo = makeRepository();
    const svc = new ModelSyncService(provider, repo);

    const result = await svc.sync();
    expect(result.success).toBe(true);
    expect(result.modelsUpserted).toBe(1);
    expect(repo.upserted).toHaveLength(1);
  });

  it('returns skipped when lock cannot be acquired', async () => {
    const provider = makeProvider([]);
    const repo = makeRepository();
    // Pre-acquire the lock
    await repo.acquireSyncLock();

    const svc = new ModelSyncService(provider, repo);
    const result = await svc.sync();
    expect(result.skipped).toBe(true);
  });

  it('handles provider errors gracefully', async () => {
    const provider: ModelProvider = {
      name: 'test',
      fetchModels: async () => {
        throw new Error('network error');
      },
    };
    const repo = makeRepository();
    const svc = new ModelSyncService(provider, repo);

    const result = await svc.sync();
    expect(result.success).toBe(false);
    expect(result.error).toContain('network error');
  });
});
