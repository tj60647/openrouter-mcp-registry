import { describe, it, expect } from 'vitest';
import { ModelSyncService } from '../services/modelSync';
import type { ModelRepository } from '../services/modelSync';
import type { ModelProvider, ProviderModel } from '../types/provider';

const makeProvider = (models: ProviderModel[]): ModelProvider => ({
  name: 'test',
  fetchModels: async () => models,
});

/** Every call the service makes against the attempt lifecycle, in order. */
type AttemptCall =
  | { kind: 'begin'; id: number }
  | {
      kind: 'complete';
      attemptId: number | null;
      success: boolean;
      error?: string;
      count?: number;
      partial?: boolean;
    };

const makeRepository = (
  overrides: Partial<ModelRepository> = {}
): ModelRepository & {
  upserted: unknown[];
  attempts: AttemptCall[];
} => {
  const upserted: unknown[] = [];
  const attempts: AttemptCall[] = [];
  let locked = false;
  let nextId = 1;
  return {
    upserted,
    attempts,
    async upsertModels(models) {
      upserted.push(...models);
      return { retired: 0, sweepSkipped: false };
    },
    async beginSyncAttempt() {
      const id = nextId++;
      attempts.push({ kind: 'begin', id });
      return id;
    },
    async completeSyncAttempt(attemptId, { success, error, count, partial }) {
      attempts.push({ kind: 'complete', attemptId, success, error, count, partial });
    },
    async acquireSyncLock() {
      if (locked) return false;
      locked = true;
      return true;
    },
    async releaseSyncLock() {
      locked = false;
    },
    ...overrides,
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

  // ── Attempt lifecycle ──────────────────────────────────────────────────────
  // Regression guard for the phantom-failure-row bug: the service used to open
  // an attempt by calling recordSyncAttempt(false), which the repository could
  // not distinguish from a real failure and appended as a second history row.

  it('opens exactly one attempt and finalises that same attempt on success', async () => {
    const provider = makeProvider([{ id: 'openai/gpt-4o', name: 'GPT-4o', contextLength: 128000 }]);
    const repo = makeRepository();

    await new ModelSyncService(provider, repo).sync();

    expect(repo.attempts).toEqual([
      { kind: 'begin', id: 1 },
      { kind: 'complete', attemptId: 1, success: true, error: undefined, count: 1, partial: false },
    ]);
  });

  it('never reports a failure while opening an attempt', async () => {
    const provider = makeProvider([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    const repo = makeRepository();

    await new ModelSyncService(provider, repo).sync();

    // The bug: opening an attempt was itself a `success: false` signal, so every
    // successful sync was preceded by a row indistinguishable from an outage.
    const failures = repo.attempts.filter((a) => a.kind === 'complete' && !a.success);
    expect(failures).toEqual([]);
  });

  it('finalises the opened attempt on failure instead of appending a new one', async () => {
    const provider: ModelProvider = {
      name: 'test',
      fetchModels: async () => {
        throw new Error('network error');
      },
    };
    const repo = makeRepository();

    await new ModelSyncService(provider, repo).sync();

    expect(repo.attempts).toHaveLength(2);
    expect(repo.attempts[0]).toEqual({ kind: 'begin', id: 1 });
    expect(repo.attempts[1]).toMatchObject({ kind: 'complete', attemptId: 1, success: false });
    expect((repo.attempts[1] as { error?: string }).error).toContain('network error');
  });

  it('records no attempt at all when the sync is skipped', async () => {
    const provider = makeProvider([]);
    const repo = makeRepository();
    await repo.acquireSyncLock();

    await new ModelSyncService(provider, repo).sync();

    expect(repo.attempts).toEqual([]);
  });

  it('still records the outcome when the attempt could not be opened', async () => {
    const provider = makeProvider([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    const repo = makeRepository({ beginSyncAttempt: async () => null });

    const result = await new ModelSyncService(provider, repo).sync();

    expect(result.success).toBe(true);
    expect(repo.attempts).toEqual([
      { kind: 'complete', attemptId: null, success: true, error: undefined, count: 1, partial: false },
    ]);
  });

  it('finalises with a null attempt id when opening the attempt throws', async () => {
    const provider = makeProvider([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    const repo = makeRepository({
      beginSyncAttempt: async () => {
        throw new Error('history table unreachable');
      },
    });

    const result = await new ModelSyncService(provider, repo).sync();

    expect(result.success).toBe(false);
    expect(repo.attempts).toEqual([
      {
        kind: 'complete',
        attemptId: null,
        success: false,
        error: 'history table unreachable',
        count: undefined,
        partial: undefined,
      },
    ]);
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

// ── Partial runs ──────────────────────────────────────────────────────────────
// When the repository skips the retirement sweep because the upstream response
// looked truncated, the run must be reported as partial rather than as a clean
// success -- otherwise an operator has no way to tell that retirement is stale.

describe('ModelSyncService partial runs', () => {
  it('marks the attempt partial when the sweep was skipped', async () => {
    const provider = makeProvider([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    const repo = makeRepository({
      upsertModels: async () => ({ retired: 0, sweepSkipped: true }),
    });

    const result = await new ModelSyncService(provider, repo).sync();

    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    expect(repo.attempts[1]).toMatchObject({ kind: 'complete', success: true, partial: true });
  });

  it('does not report a retired count for a partial run', async () => {
    const provider = makeProvider([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    const repo = makeRepository({
      upsertModels: async () => ({ retired: 0, sweepSkipped: true }),
    });

    const result = await new ModelSyncService(provider, repo).sync();

    // Reporting "0 retired" would read as "nothing needed retiring", which is
    // the opposite of what a skipped sweep means.
    expect(result).not.toHaveProperty('modelsRetired');
  });

  it('reports the retired count for a complete run', async () => {
    const provider = makeProvider([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    const repo = makeRepository({
      upsertModels: async () => ({ retired: 4, sweepSkipped: false }),
    });

    const result = await new ModelSyncService(provider, repo).sync();

    expect(result.modelsRetired).toBe(4);
    expect(result.partial).toBeUndefined();
  });
});
