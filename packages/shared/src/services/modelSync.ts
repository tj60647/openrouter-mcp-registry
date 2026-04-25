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
        const rawInputPrice = pm.pricing?.prompt ? parseFloat(pm.pricing.prompt) * 1000 : null;
        const rawOutputPrice = pm.pricing?.completion
          ? parseFloat(pm.pricing.completion) * 1000
          : null;
        const rawImagePrice = pm.pricing?.image ? parseFloat(pm.pricing.image) * 1000 : null;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const {
          id: _id,
          name: _name,
          contextLength: _cl,
          pricing: _p,
          description: _desc,
          modality: _mod,
          maxCompletionTokens: _mct,
          createdTimestamp: _ct,
          expirationDate: _ed,
          supportedParameters: _sp,
          ...rest
        } = pm;

        return {
          id,
          provider,
          displayName: pm.name,
          description: pm.description ?? null,
          modality: pm.modality ?? null,
          contextLength: pm.contextLength ?? null,
          maxCompletionTokens: pm.maxCompletionTokens ?? null,
          inputPricePer1k: rawInputPrice != null && !isNaN(rawInputPrice) ? rawInputPrice : null,
          outputPricePer1k:
            rawOutputPrice != null && !isNaN(rawOutputPrice) ? rawOutputPrice : null,
          imagePricePer1k: rawImagePrice != null && !isNaN(rawImagePrice) ? rawImagePrice : null,
          createdAt: pm.createdTimestamp != null ? new Date(pm.createdTimestamp * 1000) : null,
          providerExpirationAt: pm.expirationDate ? new Date(pm.expirationDate) : null,
          supportedParameters: pm.supportedParameters ?? [],
          metadata: rest as Record<string, unknown>,
          fetchedAt: now,
          lastSeenAt: now,
          retiredAt: null,
          isAvailable: true,
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
