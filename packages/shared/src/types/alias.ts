export type AliasScope = 'system' | 'org';

export interface Alias {
  alias: string;
  modelId: string;
  scope: AliasScope;
  createdAt: Date;
}

export interface AliasRow {
  alias: string;
  model_id: string;
  scope: AliasScope;
  created_at: Date;
}

export function rowToAlias(row: AliasRow): Alias {
  return {
    alias: row.alias,
    modelId: row.model_id,
    scope: row.scope,
    createdAt: row.created_at,
  };
}
