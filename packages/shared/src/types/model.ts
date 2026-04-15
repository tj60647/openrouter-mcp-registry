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
  context_length: number | null;
  input_price_per_1k: number | null;
  output_price_per_1k: number | null;
  metadata: Record<string, unknown>;
  fetched_at: Date;
}

export function rowToModel(row: ModelRow): Model {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    contextLength: row.context_length,
    inputPricePer1k: row.input_price_per_1k,
    outputPricePer1k: row.output_price_per_1k,
    metadata: row.metadata,
    fetchedAt: row.fetched_at,
  };
}
