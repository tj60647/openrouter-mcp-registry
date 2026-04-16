export interface Model {
  id: string;
  provider: string;
  displayName: string;
  contextLength: number | null;
  inputPricePer1k: number | null;
  outputPricePer1k: number | null;
  metadata: Record<string, unknown>;
  fetchedAt: Date;
}

export interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  context_length: number | string | null;
  input_price_per_1k: number | string | null;
  output_price_per_1k: number | string | null;
  metadata: Record<string, unknown>;
  fetched_at: Date | string;
}

function toNullableNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function rowToModel(row: ModelRow): Model {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    contextLength: toNullableNumber(row.context_length),
    inputPricePer1k: toNullableNumber(row.input_price_per_1k),
    outputPricePer1k: toNullableNumber(row.output_price_per_1k),
    metadata: row.metadata,
    fetchedAt: new Date(row.fetched_at),
  };
}
