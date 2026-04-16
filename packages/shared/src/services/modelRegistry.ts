import { canonicalizeModelId, isCanonicalId } from './canonicalize';
import type { Model } from '../types/model';

export interface ModelLookup {
  findById(id: string): Promise<Model | null>;
}

export interface ResolveResult {
  resolved: string;
  source: 'canonical' | 'normalized';
  model: Model | null;
}

export class ModelRegistry {
  constructor(private readonly modelLookup: ModelLookup) {}

  async resolve(input: string): Promise<ResolveResult> {
    const normalized = canonicalizeModelId(input);

    // If it looks like a canonical ID, look it up directly
    if (isCanonicalId(normalized)) {
      const model = await this.modelLookup.findById(normalized);
      return { resolved: normalized, source: 'canonical', model };
    }

    // Return the normalized string even if not found
    return { resolved: normalized, source: 'normalized', model: null };
  }
}
