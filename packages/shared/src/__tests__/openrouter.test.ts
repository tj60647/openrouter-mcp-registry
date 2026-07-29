/**
 * @file openrouter.test.ts
 * Tests for the OpenRouter provider, which is the only place raw upstream JSON
 * enters the system. Two things are load-bearing: a failed fetch must fail
 * loudly rather than resolve to an empty catalogue (the sync service retires
 * every model missing from a response it trusts), and every field the
 * normalizer maps must be type-checked at the boundary, because everything
 * downstream — pricing arithmetic, `new Date(createdTimestamp * 1000)`, the
 * supported-parameters array column — assumes those types hold.
 *
 * Author: Thomas J McLeish
 * License: MIT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterProvider } from '../providers/openrouter';
import type { ProviderModel } from '../types/provider';

const mockFetch = vi.fn();

const API_KEY = 'sk-or-test-key';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Shaped after a real GET /api/v1/models entry, including keys we never map. */
const UPSTREAM_MODEL: Record<string, unknown> = {
  id: 'anthropic/claude-3.5-sonnet',
  canonical_slug: 'anthropic/claude-3.5-sonnet-20241022',
  hugging_face_id: '',
  name: 'Anthropic: Claude 3.5 Sonnet',
  created: 1729555200,
  description: 'New Claude 3.5 Sonnet delivers better-than-Opus capabilities.',
  context_length: 200000,
  architecture: {
    modality: 'text+image->text',
    tokenizer: 'Claude',
    instruct_type: null,
  },
  pricing: {
    prompt: '0.000003',
    completion: '0.000015',
    image: '0.0048',
    request: '0',
  },
  top_provider: {
    context_length: 200000,
    max_completion_tokens: 8192,
    is_moderated: true,
  },
  per_request_limits: null,
  expiration_date: '2026-10-22',
  supported_parameters: ['tools', 'temperature', 'max_tokens'],
};

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Runs one upstream record through fetchModels and returns what came back. */
async function normalizeOne(raw: Record<string, unknown>): Promise<ProviderModel> {
  mockFetch.mockResolvedValueOnce(jsonResponse({ data: [raw] }));
  const models = await new OpenRouterProvider(API_KEY).fetchModels();
  return models[0] as ProviderModel;
}

function requestInit(): RequestInit {
  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  return init;
}

function requestHeaders(): Record<string, string> {
  return requestInit().headers as Record<string, string>;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── The outgoing request ──────────────────────────────────────────────────────

describe('OpenRouterProvider request', () => {
  it('asks OpenRouter for the model catalogue', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await new OpenRouterProvider(API_KEY).fetchModels();

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://openrouter.ai/api/v1/models');
  });

  it('authenticates with the api key it was constructed with', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await new OpenRouterProvider(API_KEY).fetchModels();

    // A key read from the wrong place shows up as a literal "undefined" in the
    // header and OpenRouter answers 401 with no hint about which key was used.
    expect(requestHeaders()['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(requestHeaders()['Authorization']).not.toContain('undefined');
  });

  it('identifies this app to OpenRouter on every call', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await new OpenRouterProvider(API_KEY).fetchModels();

    // OpenRouter attributes and rate-limits traffic by these two headers.
    expect(requestHeaders()['HTTP-Referer']).toBeTruthy();
    expect(requestHeaders()['X-Title']).toBeTruthy();
  });

  it('bounds the request so a hung upstream fails instead of hanging', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await new OpenRouterProvider(API_KEY).fetchModels();

    // The sync runs from a cron invocation with a finite budget; an unbounded
    // fetch would hold the sync lock until the platform killed the function.
    expect(requestInit().signal).toBeInstanceOf(AbortSignal);
  });

  it('reads the catalogue without sending a body or changing the method', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await new OpenRouterProvider(API_KEY).fetchModels();

    expect(requestInit().body).toBeUndefined();
    expect(requestInit().method).toBeUndefined();
  });
});

// ── Error paths ───────────────────────────────────────────────────────────────

describe('OpenRouterProvider failure handling', () => {
  it('names the status code when OpenRouter rejects the request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'no credits' }, 402, 'Payment Required'));

    // The status is the only thing that tells an operator whether to rotate a
    // key, top up credits, or wait it out, so it must reach the history row.
    await expect(new OpenRouterProvider(API_KEY).fetchModels()).rejects.toThrow('402');
  });

  it('does not turn a failed request into an empty catalogue', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500, 'Internal Server Error'));

    const outcome = await new OpenRouterProvider(API_KEY)
      .fetchModels()
      .catch((err: unknown) => err);

    // Resolving to [] here would look to the sync service like OpenRouter had
    // dropped every model, which is a retirement sweep away from wiping the
    // catalogue. An outage must surface as a rejection.
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toEqual([]);
  });

  it('rejects a payload whose data field is not a list of models', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { models: [] } }));

    await expect(new OpenRouterProvider(API_KEY).fetchModels()).rejects.toThrow(
      'Unexpected OpenRouter API response format'
    );
  });

  it('rejects a payload with no data field at all', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limited' } }));

    // An error object served with a 200 is the shape most likely to be mistaken
    // for a successful-but-empty catalogue.
    await expect(new OpenRouterProvider(API_KEY).fetchModels()).rejects.toThrow(
      'Unexpected OpenRouter API response format'
    );
  });

  it('accepts a genuinely empty catalogue as a successful result', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const models = await new OpenRouterProvider(API_KEY).fetchModels();

    // The distinction that matters: an empty list is a fact about the upstream
    // catalogue, not a failure, and must not be conflated with one.
    expect(models).toEqual([]);
  });

  it('propagates a transport failure rather than swallowing it', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(new OpenRouterProvider(API_KEY).fetchModels()).rejects.toThrow('fetch failed');
  });
});

// ── Normalization ─────────────────────────────────────────────────────────────

describe('OpenRouterProvider model normalization', () => {
  it('returns one normalized model per upstream entry', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [UPSTREAM_MODEL, { ...UPSTREAM_MODEL, id: 'openai/gpt-4o' }],
      })
    );

    const models = await new OpenRouterProvider(API_KEY).fetchModels();

    expect(models.map((m) => m.id)).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4o']);
  });

  it('maps a realistic model onto the fields the sync service consumes', async () => {
    const model = await normalizeOne(UPSTREAM_MODEL);

    expect(model.id).toBe('anthropic/claude-3.5-sonnet');
    expect(model.name).toBe('Anthropic: Claude 3.5 Sonnet');
    expect(model.contextLength).toBe(200000);
    expect(model.description).toBe(
      'New Claude 3.5 Sonnet delivers better-than-Opus capabilities.'
    );
    expect(model.pricing).toEqual({
      prompt: '0.000003',
      completion: '0.000015',
      image: '0.0048',
      request: '0',
    });
    expect(model.createdTimestamp).toBe(1729555200);
    expect(model.expirationDate).toBe('2026-10-22');
    expect(model.supportedParameters).toEqual(['tools', 'temperature', 'max_tokens']);
  });

  it('lifts the modality out of the architecture block', async () => {
    const model = await normalizeOne(UPSTREAM_MODEL);

    expect(model.modality).toBe('text+image->text');
  });

  it('lifts the completion-token ceiling out of the top provider block', async () => {
    const model = await normalizeOne(UPSTREAM_MODEL);

    // Nested under top_provider upstream, flat on the row downstream — a mapping
    // that silently returns undefined would read as "no documented ceiling".
    expect(model.maxCompletionTokens).toBe(8192);
  });

  it('falls back to the model id when the catalogue entry has no display name', async () => {
    const { name: _name, ...withoutName } = UPSTREAM_MODEL;

    const model = await normalizeOne(withoutName);

    expect(model.name).toBe('anthropic/claude-3.5-sonnet');
    expect(model.name).not.toBe('undefined');
  });

  it('falls back to the model id when the display name is null', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, name: null });

    // String(null) is "null", so a fallback that only guards against undefined
    // would put the word "null" on the models page.
    expect(model.name).toBe('anthropic/claude-3.5-sonnet');
    expect(model.name).not.toBe('null');
  });
});

// ── Defensive mapping ─────────────────────────────────────────────────────────
// Upstream occasionally serves a numeric field as a string. Each of these
// asserts the wrong-typed value is dropped, not carried through: a string in a
// numeric column fails the insert, and a string in `created` reaches
// `new Date(value * 1000)` where it becomes an Invalid Date instead of an error.

describe('OpenRouterProvider defensive mapping', () => {
  it('drops a context length that arrived as a string', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, context_length: '200000' });

    expect(model.contextLength).toBeUndefined();
    expect(model.contextLength).not.toBe('200000');
    // Nor may it survive under its upstream name and end up in metadata.
    expect(model).not.toHaveProperty('context_length');
  });

  it('drops a completion-token ceiling that arrived as a string', async () => {
    const model = await normalizeOne({
      ...UPSTREAM_MODEL,
      top_provider: { max_completion_tokens: '8192', is_moderated: true },
    });

    expect(model.maxCompletionTokens).toBeUndefined();
    expect(model.maxCompletionTokens).not.toBe('8192');
  });

  it('drops a created timestamp that arrived as a string', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, created: '2024-10-22T00:00:00Z' });

    expect(model.createdTimestamp).toBeUndefined();
    expect(model.createdTimestamp).not.toBe('2024-10-22T00:00:00Z');
  });

  it('drops an expiry date that did not arrive as a date string', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, expiration_date: 1792627200 });

    expect(model.expirationDate).toBeUndefined();
    expect(model.expirationDate).not.toBe(1792627200);
  });

  it('drops a description that did not arrive as text', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, description: { en: 'hello' } });

    expect(model.description).toBeUndefined();
  });

  it('keeps only the string entries of a mixed supported-parameters list', async () => {
    const model = await normalizeOne({
      ...UPSTREAM_MODEL,
      supported_parameters: ['tools', 42, null, 'temperature', { name: 'seed' }],
    });

    // This array is written straight into a text[] column, so one non-string
    // entry would take the whole sync down with a type error.
    expect(model.supportedParameters).toEqual(['tools', 'temperature']);
    expect(model.supportedParameters).not.toContain(42);
    expect(model.supportedParameters).not.toContain(null);
  });

  it('leaves supported parameters unset when the field is not a list', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, supported_parameters: 'tools' });

    // Unset rather than ['t','o','o','l','s'] — the sync service substitutes an
    // empty array, which is the honest answer when upstream sent nonsense.
    expect(model.supportedParameters).toBeUndefined();
  });

  it('handles a model with no architecture block at all', async () => {
    const { architecture: _architecture, ...withoutArchitecture } = UPSTREAM_MODEL;

    const model = await normalizeOne(withoutArchitecture);

    expect(model.modality).toBeUndefined();
    expect(model.id).toBe('anthropic/claude-3.5-sonnet');
  });

  it('handles a null architecture block without throwing', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, architecture: null });

    expect(model.modality).toBeUndefined();
  });

  it('handles a model with no top provider block at all', async () => {
    const { top_provider: _topProvider, ...withoutTopProvider } = UPSTREAM_MODEL;

    const model = await normalizeOne(withoutTopProvider);

    expect(model.maxCompletionTokens).toBeUndefined();
    expect(model.contextLength).toBe(200000);
  });

  it('drops a modality that did not arrive as text', async () => {
    const model = await normalizeOne({
      ...UPSTREAM_MODEL,
      architecture: { modality: ['text', 'image'], tokenizer: 'Claude' },
    });

    expect(model.modality).toBeUndefined();
  });
});

// ── Metadata passthrough ──────────────────────────────────────────────────────
// Everything the normalizer does not map is spread onto the model and becomes
// the row's `metadata` JSON downstream. Mapped fields must not appear there as
// well, or every value is stored twice and the two copies can disagree.

describe('OpenRouterProvider metadata passthrough', () => {
  it('carries unmapped upstream keys through untouched', async () => {
    const model = await normalizeOne({ ...UPSTREAM_MODEL, some_new_field: { beta: true } });

    expect(model['canonical_slug']).toBe('anthropic/claude-3.5-sonnet-20241022');
    expect(model['per_request_limits']).toBeNull();
    expect(model['some_new_field']).toEqual({ beta: true });
  });

  it('does not repeat mapped fields under their upstream names', async () => {
    const model = await normalizeOne(UPSTREAM_MODEL);

    expect(model).not.toHaveProperty('context_length');
    expect(model).not.toHaveProperty('top_provider');
    expect(model).not.toHaveProperty('architecture');
    expect(model).not.toHaveProperty('created');
    expect(model).not.toHaveProperty('expiration_date');
    expect(model).not.toHaveProperty('supported_parameters');
  });

  it('does not invent fields for a model that carries only an id', async () => {
    const model = await normalizeOne({ id: 'tiny/model' });

    expect(model.name).toBe('tiny/model');
    expect(model.contextLength).toBeUndefined();
    expect(model.pricing).toBeUndefined();
    expect(model.modality).toBeUndefined();
    expect(model.maxCompletionTokens).toBeUndefined();
    expect(model.createdTimestamp).toBeUndefined();
    expect(model.expirationDate).toBeUndefined();
    expect(model.supportedParameters).toBeUndefined();
  });
});
