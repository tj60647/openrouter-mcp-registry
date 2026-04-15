export interface ProviderModel {
  id: string;
  name: string;
  contextLength?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  [key: string]: unknown;
}

export interface ModelProvider {
  name: string;
  fetchModels(): Promise<ProviderModel[]>;
}
