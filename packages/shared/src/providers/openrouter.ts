import type { ModelProvider, ProviderModel } from '../types/provider';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models';

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async fetchModels(): Promise<ProviderModel[]> {
    const response = await fetch(OPENROUTER_API_URL, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/tj60647/openrouter-mcp-registry',
        'X-Title': 'OpenRouter MCP Registry',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(
        `OpenRouter API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { data: unknown[] };
    if (!Array.isArray(data?.data)) {
      throw new Error('Unexpected OpenRouter API response format');
    }

    return data.data.map((raw) => normalizeModel(raw as Record<string, unknown>));
  }
}

function normalizeModel(raw: Record<string, unknown>): ProviderModel {
  const id = String(raw['id'] ?? '');
  const name = String(raw['name'] ?? id);
  const contextLength =
    typeof raw['context_length'] === 'number' ? raw['context_length'] : undefined;

  const pricing = raw['pricing'] as
    | { prompt?: string; completion?: string }
    | undefined;

  // Remove fields we've explicitly mapped
  const { id: _id, name: _name, context_length: _cl, pricing: _pricing, ...rest } = raw;
  void _id; void _name; void _cl; void _pricing;

  return { id, name, contextLength, pricing, ...rest };
}
