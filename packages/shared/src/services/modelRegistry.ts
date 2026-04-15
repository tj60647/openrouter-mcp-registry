import { canonicalizeModelId, isCanonicalId } from './canonicalize';
import type { AliasLookup } from './aliasService';
import type { Model } from '../types/model';

export interface ModelLookup {
  findById(id: string): Promise<Model | null>;
}

export interface ResolveResult {
  resolved: string;
  source: 'alias' | 'canonical' | 'normalized';
  model: Model | null;
}

export class ModelRegistry {
  constructor(
    private readonly modelLookup: ModelLookup,
    private readonly aliasLookup: AliasLookup
  ) {}

  async resolve(input: string): Promise<ResolveResult> {
    const normalized = canonicalizeModelId(input);

    // 1. Try alias resolution first
    const aliasTarget = await this.aliasLookup.resolveAlias(normalized);
    if (aliasTarget) {
      const model = await this.modelLookup.findById(aliasTarget);
      return { resolved: aliasTarget, source: 'alias', model };
    }

    // 2. If it looks like a canonical ID, look it up directly
    if (isCanonicalId(normalized)) {
      const model = await this.modelLookup.findById(normalized);
      return { resolved: normalized, source: 'canonical', model };
    }

    // 3. Return the normalized string even if not found
    return { resolved: normalized, source: 'normalized', model: null };
  }
}
