import type { ModelProvider } from '../types/provider';
import type { Model } from '../types/model';
import { canonicalizeModelId, extractProvider } from './canonicalize';

export interface ModelRepository {
  upsertModels(models: Model[]): Promise<void>;
  recordSyncAttempt(success: boolean, error?: string, count?: number): Promise<void>;
  acquireSyncLock(): Promise<boolean>;
  releaseSyncLock(): Promise<void>;
}

export interface SyncOptions {
  force?: boolean;
}

export interface SyncResult {
  success: boolean;
  modelsUpserted: number;
  error?: string;
  skipped?: boolean;
}

export class ModelSyncService {
  constructor(
    private readonly provider: ModelProvider,
    private readonly repository: ModelRepository
  ) {}

  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const locked = await this.repository.acquireSyncLock();
    if (!locked && !options.force) {
      return { success: true, modelsUpserted: 0, skipped: true };
    }

    try {
      await this.repository.recordSyncAttempt(false);
      const providerModels = await this.provider.fetchModels();
      const now = new Date();

      const models: Model[] = providerModels.map((pm) => {
        const id = canonicalizeModelId(pm.id);
        const provider = extractProvider(id);
        const inputPrice = pm.pricing?.prompt
          ? parseFloat(pm.pricing.prompt) * 1000
          : null;
        const outputPrice = pm.pricing?.completion
          ? parseFloat(pm.pricing.completion) * 1000
          : null;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id: _id, name: _name, contextLength: _cl, pricing: _p, ...rest } = pm;

        return {
          id,
          provider,
          displayName: pm.name,
          contextLength: pm.contextLength ?? null,
          inputPricePer1k: isNaN(inputPrice as number) ? null : inputPrice,
          outputPricePer1k: isNaN(outputPrice as number) ? null : outputPrice,
          metadata: rest as Record<string, unknown>,
          fetchedAt: now,
        };
      });

      await this.repository.upsertModels(models);
      await this.repository.recordSyncAttempt(true, undefined, models.length);

      return { success: true, modelsUpserted: models.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repository.recordSyncAttempt(false, message);
      return { success: false, modelsUpserted: 0, error: message };
    } finally {
      await this.repository.releaseSyncLock();
    }
  }
}
