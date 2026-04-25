export interface Model {
  id: string;
  provider: string;
  displayName: string;
  description: string | null;
  modality: string | null;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  inputPricePer1k: number | null;
  outputPricePer1k: number | null;
  imagePricePer1k: number | null;
  /** When the model was published on OpenRouter (from provider data) */
  createdAt: Date | null;
  /** Scheduled provider expiry from OpenRouter, when supplied. */
  providerExpirationAt: Date | null;
  /** Parameters supported by the model (e.g. 'tools', 'temperature'). */
  supportedParameters: string[];
  metadata: Record<string, unknown>;
  fetchedAt: Date;
  /** Last successful sync where this model was present in OpenRouter's catalog. */
  lastSeenAt: Date | null;
  /** When the registry first marked this model unavailable after a sync. */
  retiredAt: Date | null;
  /** Whether the model was present in the most recent sync from OpenRouter. */
  isAvailable: boolean;
}

export interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  description: string | null;
  modality: string | null;
  context_length: number | string | null;
  max_completion_tokens: number | string | null;
  input_price_per_1k: number | string | null;
  output_price_per_1k: number | string | null;
  image_price_per_1k: number | string | null;
  created_at: Date | string | null;
  provider_expiration_at: Date | string | null;
  supported_parameters: string[] | null;
  metadata: Record<string, unknown>;
  fetched_at: Date | string;
  last_seen_at: Date | string | null;
  retired_at: Date | string | null;
  is_available: boolean | null;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rowToModel(row: ModelRow): Model {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    description: row.description ?? null,
    modality: row.modality ?? null,
    contextLength: toNullableNumber(row.context_length),
    maxCompletionTokens: toNullableNumber(row.max_completion_tokens),
    inputPricePer1k: toNullableNumber(row.input_price_per_1k),
    outputPricePer1k: toNullableNumber(row.output_price_per_1k),
    imagePricePer1k: toNullableNumber(row.image_price_per_1k),
    createdAt: row.created_at != null ? new Date(row.created_at) : null,
    providerExpirationAt:
      row.provider_expiration_at != null ? new Date(row.provider_expiration_at) : null,
    supportedParameters: row.supported_parameters ?? [],
    metadata: row.metadata,
    fetchedAt: new Date(row.fetched_at),
    lastSeenAt: row.last_seen_at != null ? new Date(row.last_seen_at) : null,
    retiredAt: row.retired_at != null ? new Date(row.retired_at) : null,
    isAvailable: row.is_available ?? true,
  };
}
