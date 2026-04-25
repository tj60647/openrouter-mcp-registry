export interface ProviderModel {
  id: string;
  name: string;
  contextLength?: number;
  description?: string;
  modality?: string;
  maxCompletionTokens?: number;
  supportedParameters?: string[];
  /** Unix seconds — when the model was published on OpenRouter */
  createdTimestamp?: number;
  /** ISO date string from OpenRouter when a model has a scheduled expiry */
  expirationDate?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
  };
  [key: string]: unknown;
}

export interface ModelProvider {
  name: string;
  fetchModels(): Promise<ProviderModel[]>;
}
